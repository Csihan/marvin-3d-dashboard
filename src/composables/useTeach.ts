/**
 * @file    useTeach.ts
 * @brief   Web 示教控制器：协作释放(RELEASE)切换、10Hz 采样、运动表、回放、S 动作与文件服务
 * @author Csihan
 * @date    2026-08-28
 *
 * 2026-09-03：文件服务地址改由 dashboard.yaml（file_server 段）配置，
 * 支撑局域网部署；默认行为与原硬编码 127.0.0.1 一致（仅本机模式时）。
 * 2026-09-05（A1）：M4 文案统一"协作释放(RELEASE)"（手册 §2.6 state=4）。
 * 2026-09-06（TEACH-MODE-CONVERGE-20260906）：示教收敛为 2 个任务模式（纯 UI/交互重构，
 *   协议字段零变更）：
 *   ① 键盘踩点（默认，enterTeachKeyboard）：一键进入零选择，**不发 mode_switch state=4**
 *      ——键盘 Jog 走位置模式指令流（与 ArmPanel 滑条同通道），臂不需要进 SDK 拖动就绪态；
 *   ② 人手拖动（enterTeach(space)）：协议序列不变（state=4 + drag_space → set_drag）。
 *   两模式共用 teaching/sampling/exitTeach；3D Jog 启用判定已扩展为
 *   「dragModeActive || teaching」（解法 A，见 scene/drag.ts jogEnabled 注释）。
 *
 * 设计口径与 Qt 示教器一致：
 *   - 协议仍是 human_extern_cmd / manipulators_control / demo_action_exec；
 *   - 运动表保存 named_points，真实回放只用 j[0..6]，TCP 位姿暂为占位字段；
 *   - 文件服务是标准库本机服务，只提供白名单文件，不引入 FastAPI。
 */
import { computed, onUnmounted, ref } from 'vue'
import * as THREE from 'three'
import { robotStore } from './useRobotStatus'
// 2026-09-03：运行配置（dashboard.yaml）——文件服务地址来源
import { getDashboardConfig, resolveFileServerBase } from '../config/dashboardConfig'
// 2026-09-04（SIM-TEACH-LOOP-M1）：回放平滑插值——minimum-jerk 五次多项式 ease。
// 拖动示教踩点后整列回放时，点与点之间不再直线硬切，而是按 easeInOut 曲线
// 加速-减速过渡，产生"仿人手臂"的平滑运动质感（详见 utils/trajectory.ts）。
import { easeInOut } from '../utils/trajectory'
import type {
  ActionLibrary, DemoActionStatus, ForceParams, GripperPreset,
  ImpedanceParams, TeachPoint,
} from '../types/robot'

export type TeachSide = 'arm_L' | 'arm_R'
type RosSender = (type: string, content: any) => Promise<any>
/** 连续型命令流发送器（2026-09-04 M1）：topic 流 fire-and-forget，
 *  与 useCommandBus.sendStream 同通道（/robot/human_extern_cmd_stream），
 *  自带 message_id 连续性维护——minimum-jerk 回放逐帧下发必须走流，
 *  service 往返延迟会导致帧间卡顿（拖动流同款结论）。 */
export type RosStream = (type: string, content: any) => void
type RosSubscriber = (topic: string, msgType: string, cb: (msg: any) => void) => unknown

/** P-B 注入（来自 useRobot3D，避免 composable 间循环依赖）：
 *  fk   = computeTool0 —— 取 tool0 世界位姿，踩点时填 xyz/四元数；
 *  ik6d = solveTool0IK6D —— 按 tool0 目标位姿反解 7 关节角（rad），笛卡尔点选执行。 */
export interface TeachIkHooks {
  fk: (side: 'L' | 'R') => { pos: THREE.Vector3; quat: THREE.Quaternion } | null
  ik6d: (side: 'L' | 'R', pos: THREE.Vector3, quat: THREE.Quaternion, angles: number[]) => number[]
}

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
// （2026-09-03）原硬编码 FILE_SERVER = 'http://127.0.0.1:8765' 已移除：
// 远程浏览器打开页面时 127.0.0.1 指向浏览器本机而非 ROS 主机，示教文件读写必挂；
// 现改为 request() 内 resolveFileServerBase(getDashboardConfig()) 运行时解析。
const CSV_HEADERS = [
  'seq', 'name', 'x', 'y', 'z', 'qw', 'qx', 'qy', 'qz',
  'j1deg', 'j2deg', 'j3deg', 'j4deg', 'j5deg', 'j6deg', 'j7deg',
]

/** 协议响应统一在 content.ret 中；保留顶层 ret 兼容后续响应封装。 */
function rosOk(res: any): boolean {
  return res?.content?.ret !== false && res?.ret !== false
}

function emptyPoint(): TeachPoint {
  return { name: '', x: 0, y: 0, z: 0, qw: 1, qx: 0, qy: 0, qz: 0, j: new Array(7).fill(0) }
}

function normalizePoint(raw: any): TeachPoint {
  const base = emptyPoint()
  const j = Array.isArray(raw?.j) ? raw.j : []
  return {
    ...base,
    ...raw,
    name: String(raw?.name ?? ''),
    j: Array.from({ length: 7 }, (_, i) => Number(j[i] ?? 0)),
  }
}

export function useTeach(send: RosSender, subscribe?: RosSubscriber, hooks?: TeachIkHooks, stream?: RosStream) {
  const side = ref<TeachSide>('arm_L')
  const teaching = ref(false)
  const sampling = ref(false)
  const rows = ref<TeachPoint[]>([])
  const selectedIndex = ref<number | null>(null)
  const message = ref('示教未激活')
  const demoRunning = ref(false)
  const demoStatus = ref<DemoActionStatus>({ actionId: '', running: false, result: null, message: '', elapsedMs: 0 })
  const presets = ref<Record<string, GripperPreset>>({})
  const lastError = ref('')
  // 2026-08-31（计划 Phase1）：拖动空间参数化——由 TeachModePanel 选择，不再写死 1。
  // 取值口径见 set_drag 服务注释：1=关节拖动 2~5=笛卡尔各向（X/Y/Z/旋转）。
  // 2026-09-06（TEACH-MODE-CONVERGE）：UI 已收敛为「人手拖动 ▾」子选项传入 enterTeach(space)，
  // 此 ref 保留为默认值兜底（接口兼容，不再作为常驻下拉）。
  const dragSpace = ref<number>(1)
  // 2026-09-06（TEACH-MODE-CONVERGE）：示教进入方式语义标记——
  //   'keyboard' = 键盘踩点（位置模式指令流，不发拖动态 state=4）；
  //   'drag'     = 人手拖动（mode_switch state=4 + drag_space，SDK 拖动就绪态）。
  // 两种方式共用同一个 teaching 状态与退出逻辑（exitTeach 不动协议），仅退出
  // message 文案按此区分（键盘踩点没进过拖动态，说"退出拖动"会让操作员困惑）。
  const teachKind = ref<'keyboard' | 'drag'>('keyboard')
  let sampleTimer: ReturnType<typeof setInterval> | null = null
  let lastSampleDeg: number[] | null = null

  // S 动作回报走低频内部流；这里绑定同一个 robotStore 引用，避免高频聚合流丢消息。
  if (subscribe) {
    subscribe('/robot/internal/demo/report', 'std_msgs/String', (msg: any) => {
      try {
        // roslib 对 String 话题的 data 字段在不同版本可能保留字符串或预解析对象。
        const payload = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data
        const data = payload.content ?? {}
        if (data?.action_id === undefined) return
        demoStatus.value = {
          actionId: data.action_id ?? '',
          running: false,
          result: typeof data.result === 'number' ? data.result : null,
          message: data.message ?? '',
          elapsedMs: data.elapsed_ms ?? 0,
        }
        demoRunning.value = false
      } catch (_) {
        // 单条非法回报直接丢弃；下一次执行会重新上报。
      }
    })
  }

  const selectedPoint = computed(() =>
    selectedIndex.value === null ? null : rows.value[selectedIndex.value] ?? null)

  // ArmPanel / JointInspector 反馈到达前立即更新本地状态，避免 3D 和面板出现跳回。
  function previewArmJoint(sideValue: 'L' | 'R', jointIndex: number, deg: number): void {
    const arm = sideValue === 'L' ? robotStore.armL : robotStore.armR
    arm.joints[jointIndex] = deg * Math.PI / 180
    lastSampleDeg = null
  }

  async function setDragMode(sideValue: TeachSide, space: number): Promise<boolean> {
    const res = await send('manipulators_control', {
      arm: sideValue === 'arm_L' ? 1 : 2,
      // 进入协作释放（RELEASE，手册 §2.6 state=4）：drag_space 交由 set_drag 服务处理
      mode_switch: { state: 4, drag_space: space },
    })
    const ok = rosOk(res)
    if (!ok) lastError.value = `mode_switch 失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    return ok
  }

  /** 键盘踩点模式进入（2026-09-06 TEACH-MODE-CONVERGE 新增，操作员任务①）。
   *  ⚠️ 与 enterTeach 的本质差异：本模式**不发 mode_switch state=4**——
   *  键盘 Jog 走位置模式指令流（joint_angles 直发，与 ArmPanel 滑条同通道），
   *  臂根本不需要进入 SDK 拖动就绪态；若发 state=4，真机上臂会进阻抗拖动态，
   *  键盘位置指令与阻抗拖动叠加语义有歧义（任务单方案 B，明确不采用）。
   *  协议零变更：这是"少发"，不是改字段（comms 对缺 drag_space 缺省 -1 不改）。
   *  前端联动：3D 内 jogEnabled() 已扩展为「M4 回显 || teaching」（见 scene/drag.ts），
   *  本函数置 teaching=true 后键盘 Jog 照常可用；startSampling 照常（10Hz 自动记点）。 */
  async function enterTeachKeyboard(): Promise<boolean> {
    teachKind.value = 'keyboard'
    teaching.value = true
    startSampling()
    message.value = '键盘踩点示教中（位置模式指令流，无需末端按钮）：10Hz 采样'
    return true
  }

  /** 人手拖动模式进入（操作员任务②；进入前 UI 必须先弹出安全确认，
   *  这里只负责协议切换和采样器生命周期。
   *  2026-08-31（计划 Phase1）：拖动空间参数化——space 由 TeachModePanel 子选项选择。
   *  2026-09-06（TEACH-MODE-CONVERGE）：标记 teachKind='drag'（退出文案区分用）；
   *  协议序列不变：mode_switch state=4 + drag_space → comms 一站式走 /arm/set_drag。 */
  async function enterTeach(space = dragSpace.value): Promise<boolean> {
    dragSpace.value = space
    if (!await setDragMode(side.value, space)) {
      message.value = lastError.value || '进入协作释放(RELEASE)失败：协议返回 false'
      return false
    }
    teachKind.value = 'drag'
    teaching.value = true
    startSampling()
    message.value = '人手拖动示教中（须按住末端按钮 m_TipDI==1）：10Hz 采样'
    return true
  }

  // —— SDK 能力补全（2026-08-31 计划 Phase1）：阻抗 / 力控参数下发 ——

  /** 阻抗参数下发：走 manipulators_control.mode_switch（state=3 TORQUE + imp_type + KD 数组）。
   *  comms 解析约定：mode_imp==1 读 joint_kd(前7=K 后7=D)；mode_imp==2 读 cart_kd(前6=K 后6=D)。 */
  async function applyImpedance(sideValue: TeachSide, p: ImpedanceParams): Promise<boolean> {
    const arm = sideValue === 'arm_L' ? 1 : 2
    const modeSwitch: Record<string, unknown> = { state: 3, imp_type: p.type }
    if (p.type === 1) modeSwitch.joint_kd = [...p.k, ...p.d]
    else modeSwitch.cart_kd = [...p.k, ...p.d]
    const res = await send('manipulators_control', { arm, mode_switch: modeSwitch })
    const ok = rosOk(res)
    if (!ok) lastError.value = `阻抗下发失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `阻抗参数已下发（type=${p.type}）`
    return ok
  }

  /** 力控参数下发：mode_switch{state:3, imp_type:3} + force{fc_type,fx_dir,ctrl,lmt}。 */
  async function applyForce(sideValue: TeachSide, p: ForceParams): Promise<boolean> {
    const arm = sideValue === 'arm_L' ? 1 : 2
    const res = await send('manipulators_control', {
      arm,
      mode_switch: {
        state: 3, imp_type: 3,
        force: { fc_type: p.fc_type, fx_dir: p.fx_dir, ctrl: p.ctrl, lmt: p.lmt },
      },
    })
    const ok = rosOk(res)
    if (!ok) lastError.value = `力控参数下发失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = '力控参数已下发'
    return ok
  }

  /** 单次力指令（力控模式下）；前端钳位 ±300N（后端 setForceCmd 二次钳位）。 */
  async function sendForceCmd(sideValue: TeachSide, force: number): Promise<boolean> {
    const clamped = Math.min(300, Math.max(-300, force))
    const res = await send('force_cmd', { arm: sideValue === 'arm_L' ? 1 : 2, force: clamped })
    const ok = rosOk(res)
    if (!ok) lastError.value = `力指令下发失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `力指令已下发：${clamped}N`
    return ok
  }

  // —— SDK 能力补全（2026-08-31 计划 Phase2/3）：PVT/采集/工具/参数/伺服/日志 ——
  // 这些协议类型走 comms 新分发分支，详情回执经 /robot/status 异步回传（面板订阅展示）。

  /** PVT 文件上传：pvt_upload{arm, file_path, serial} → comms → /arm/send_pvt */
  async function uploadPvt(sideValue: TeachSide, filePath: string, serial: number): Promise<boolean> {
    const res = await send('pvt_upload', {
      arm: sideValue === 'arm_L' ? 1 : 2, file_path: filePath, serial,
    })
    const ok = rosOk(res)
    if (!ok) lastError.value = `PVT 上传失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `PVT 上传已受理（${filePath}，段号 ${serial}）`
    return ok
  }

  /** 轨迹采集：gather_control{arm, action, target_ids, record_num, save_path}
   *  action 1=开始 2=停止 3=存 CSV。 */
  async function gatherControl(sideValue: TeachSide, action: number,
    targetIds: number[], recordNum: number, savePath = ''): Promise<boolean> {
    const res = await send('gather_control', {
      arm: sideValue === 'arm_L' ? 1 : 2, action, target_ids: targetIds,
      record_num: recordNum, save_path: savePath,
    })
    const ok = rosOk(res)
    if (!ok) lastError.value = `采集指令失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `采集已受理（action=${action}）`
    return ok
  }

  /** 工具参数下发：tool_set{arm, kine[6], dyn[10]} → comms → /arm/set_tool */
  async function setToolParams(sideValue: TeachSide, kine: number[], dyn: number[]): Promise<boolean> {
    const res = await send('tool_set', {
      arm: sideValue === 'arm_L' ? 1 : 2, kine, dyn,
    })
    const ok = rosOk(res)
    if (!ok) lastError.value = `工具参数下发失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = '工具参数已下发'
    return ok
  }

  /** 等待 /robot/status 上 header.type 匹配的协议响应。
   *  comms 的服务应答仅是"受理"，真实结果（content.ret/message/data）异步经
   *  /robot/status 回传（与 para_get/demo 回报同机制）；按 type 捕获第一条响应。
   *  @param wantType 命令类型（tool_get / tool_save）
   *  @param timeoutMs 超时（默认 3s）
   *  @returns 响应 content 对象；超时/未注入 subscribe 返回 null。 */
  function waitForProtocolResponse(wantType: string, timeoutMs = 3000): Promise<any | null> {
    if (!subscribe) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      let handle: unknown = null
      const finish = (v: any) => {
        if (settled) return
        settled = true
        // 一次性响应：取到即退订，避免长期挂在聚合状态话题上
        try { (handle as { unsubscribe?: () => void } | null)?.unsubscribe?.() } catch (_) { /* 清理失败可忽略 */ }
        resolve(v)
      }
      handle = subscribe('/robot/status', 'std_msgs/String', (msg: any) => {
        try {
          // roslib 对 String 的 data 可能保留字符串或预解析对象（与 demo report 同口径）
          const raw = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)
          const data = JSON.parse(raw)
          if (data?.header?.type === wantType) finish(data?.content ?? null)
        } catch (_) { /* 单条非法消息直接忽略 */ }
      })
      setTimeout(() => finish(null), timeoutMs)
    })
  }

  /** 工具参数读取（2026-09-02）：tool_get{arm} → comms → /arm/tool_get；
   *  返回节点内存中"当前生效"的 kine/dyn（启动=yaml 值；下发/保存成功后=最新值）。
   *  @returns 成功 = {kine[6], dyn[10]}；失败 = null（lastError 已置原因）。 */
  async function getToolParams(sideValue: TeachSide): Promise<{ kine: number[]; dyn: number[] } | null> {
    // 先挂监听再发送，避免响应早于订阅到达而漏收
    const pending = waitForProtocolResponse('tool_get')
    const res = await send('tool_get', { arm: sideValue === 'arm_L' ? 1 : 2 })
    if (!rosOk(res)) {
      lastError.value = `工具参数读取失败：${res?.values ?? res?.message ?? '协议返回 false'}`
      return null
    }
    const content = await pending
    const d = content?.data ?? {}
    const kine = Array.isArray(d.kine) ? d.kine.map(Number) : []
    const dyn = Array.isArray(d.dyn) ? d.dyn.map(Number) : []
    if (kine.length !== 6 || dyn.length !== 10) {
      lastError.value = '工具参数读取失败：响应超时或缺 kine[6]/dyn[10]'
      return null
    }
    message.value = '工具参数已读取（当前生效值）'
    return { kine, dyn }
  }

  /** 工具参数保存（2026-09-02）：tool_save{arm, kine[6], dyn[10]} → comms → /arm/tool_save；
   *  驱动侧先 SDK SetTool 立即生效（失败不写文件），再保注释回写 arm_L/arm_R.yaml
   *  （服务端持久化文件），重启节点后仍生效。
   *  成败以 /robot/status 回传的驱动结论为准（yaml 写失败会如实上报）。 */
  async function saveToolParams(sideValue: TeachSide, kine: number[], dyn: number[]): Promise<boolean> {
    const pending = waitForProtocolResponse('tool_save')
    const res = await send('tool_save', {
      arm: sideValue === 'arm_L' ? 1 : 2, kine, dyn,
    })
    if (!rosOk(res)) {
      lastError.value = `工具参数保存失败：${res?.values ?? res?.message ?? '协议返回 false'}`
      return false
    }
    const content = await pending
    if (!content || content.ret !== true) {
      lastError.value = `工具参数保存失败：${content?.message ?? '响应超时未收到驱动确认'}`
      return false
    }
    message.value = `工具参数已保存：${content.message ?? 'SDK 生效 + yaml 已更新'}`
    return true
  }

  /** robot.ini 参数写：para_set{para_name, type, value}（robot.ini 为全局参数，无臂之分） */
  async function setPara(name: string, type: 1 | 2, value: number): Promise<boolean> {
    const res = await send('para_set', { para_name: name, type, value })
    const ok = rosOk(res)
    if (!ok) lastError.value = `参数写失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `参数已写入：${name}`
    return ok
  }

  /** robot.ini 参数读：para_get{para_name, type}；结果经 /robot/status(module=arm_para) 回传 */
  async function getPara(name: string, type: 1 | 2): Promise<boolean> {
    const res = await send('para_get', { para_name: name, type })
    const ok = rosOk(res)
    if (!ok) lastError.value = `参数读失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `参数读取已受理：${name}`
    return ok
  }

  /** robot.ini 参数保存：para_save */
  async function savePara(): Promise<boolean> {
    const res = await send('para_save', {})
    const ok = rosOk(res)
    if (!ok) lastError.value = `参数保存失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = '参数保存已受理'
    return ok
  }

  /** 伺服软复位：servo_reset{axis, arm}（axis -1=全部 0~6=单轴）；安全敏感需确认 */
  async function servoReset(sideValue: TeachSide, axis: number): Promise<boolean> {
    const res = await send('servo_reset', {
      arm: sideValue === 'arm_L' ? 1 : 2, axis,
    })
    const ok = rosOk(res)
    if (!ok) lastError.value = `伺服复位失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `伺服复位已受理（axis=${axis}）`
    return ok
  }

  /** 日志下载：log_download{save_path}；内容经 /robot/status(module=arm_log) 回传 */
  async function downloadLog(savePath: string): Promise<boolean> {
    const res = await send('log_download', { save_path: savePath })
    const ok = rosOk(res)
    if (!ok) lastError.value = `日志下载失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `日志下载已受理（${savePath}）`
    return ok
  }

  async function exitTeach(): Promise<void> {
    stopSampling()
    // 协议退出序列保持不变（两种进入方式共用）：set_drag space=0（comms 一站式
    // 服务内部 ExitDrag + 回位置模式）+ state=1。键盘踩点模式从未发过 state=4，
    // 这两条是幂等补发——后端实测依据（重复下发无害）：
    //   comms handleModeSwitch 对 state=4+drag_space=0 走 /arm/set_drag(space=0)，
    //   内部写 FSM=ENABLED/POSITION；MockArmBackend::setDragSpace(0) 仅记 type 回 mode=1。
    //   Mock/真机都接受重复退出，无害。
    await setDragMode(side.value, 0)
    await send('manipulators_control', {
      arm: side.value === 'arm_L' ? 1 : 2,
      mode_switch: { state: 1 },
    })
    teaching.value = false
    // 2026-09-06（TEACH-MODE-CONVERGE）：退出文案按进入方式区分（任务单验收 c）——
    // 状态面板都会回到"位置"（协议序列相同），仅提示语不一样。
    message.value = teachKind.value === 'keyboard'
      ? '已退出示教（键盘踩点）'
      : '已退出拖动并回到位置模式'
  }

  function startSampling(): void {
    if (sampleTimer) return
    sampling.value = true
    lastSampleDeg = null
    sampleTimer = setInterval(captureAutoPoint, 100)
  }

  function stopSampling(): void {
    if (!sampleTimer) return
    clearInterval(sampleTimer)
    sampleTimer = null
    sampling.value = false
  }

  /** 所有 7 轴变化都小于 0.5° 视为静止；手动补点先清除上一帧再强制采样。 */
  function captureAutoPoint(manual = false): void {
    const arm = side.value === 'arm_L' ? robotStore.armL : robotStore.armR
    if (arm.joints.length < 7) return
    const deg = arm.joints.slice(0, 7).map(v => Number((v * RAD2DEG).toFixed(1)))
    if (!manual && lastSampleDeg && deg.every((v, i) => Math.abs(v - lastSampleDeg![i]) < 0.5)) return
    lastSampleDeg = deg
    const point = emptyPoint()
    point.j = deg
    // P-B：FK 填充 tool0 笛卡尔位姿（xyz+四元数）——此前为占位 0/单位四元数。
    // 拖动示教踩点时记录的是末端真实位姿，供笛卡尔点选执行与动作库导出使用。
    const pose = hooks?.fk?.(side.value === 'arm_L' ? 'L' : 'R')
    if (pose) {
      point.x = pose.pos.x; point.y = pose.pos.y; point.z = pose.pos.z
      point.qw = pose.quat.w; point.qx = pose.quat.x; point.qy = pose.quat.y; point.qz = pose.quat.z
    }
    rows.value.push(point)
    selectedIndex.value = rows.value.length - 1
    if (manual) message.value = `已手动补点：第 ${rows.value.length} 行`
  }

  function captureManualPoint(): void {
    lastSampleDeg = null
    captureAutoPoint(true)
  }

  function deleteSelected(): void {
    if (selectedIndex.value === null) return
    rows.value.splice(selectedIndex.value, 1)
    selectedIndex.value = rows.value.length ? Math.min(selectedIndex.value, rows.value.length - 1) : null
    if (!rows.value.length) lastSampleDeg = null
  }

  function renameSelected(name: string): void {
    if (selectedPoint.value) selectedPoint.value.name = name
  }

  function buildCsv(): string {
    const lines = [CSV_HEADERS.join(',')]
    rows.value.forEach((p, index) => {
      const scalar = [p.x, p.y, p.z, p.qw, p.qx, p.qy, p.qz]
        .map(v => Number(v ?? 0).toFixed(4)).join(',')
      const joints = p.j.map(v => Number(v ?? 0).toFixed(1)).join(',')
      const name = `"${String(p.name ?? '').replaceAll('"', '""')}"`
      lines.push(`${index + 1},${name},${scalar},${joints}`)
    })
    return `${lines.join('\n')}\n`
  }

  async function request(path: string, method: 'GET' | 'PUT' | 'POST', body?: any): Promise<any> {
    // 2026-09-03：文件服务地址运行时解析（dashboard.yaml file_server 段）。
    // host='auto' → 跟随页面主机：与"页面从哪台机打开"天然一致，局域网零改动。
    const res = await fetch(`${resolveFileServerBase(getDashboardConfig())}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`)
    return res.json()
  }

  async function saveTeach(): Promise<void> {
    await request(`/api/teach/${side.value}`, 'PUT', {
      replay_auto_enable: false,
      named_points: rows.value,
    })
    message.value = `YAML 已保存：${side.value}`
  }

  async function loadTeach(): Promise<void> {
    const data = await request(`/api/teach/${side.value}`, 'GET')
    rows.value = (data.named_points ?? []).map(normalizePoint)
    selectedIndex.value = rows.value.length ? 0 : null
    message.value = `YAML 已加载：${rows.value.length} 行`
  }

  async function exportCsv(): Promise<void> {
    await request(`/api/export-csv/${side.value}`, 'POST', { content: buildCsv() })
    message.value = `CSV 已导出：${side.value}`
  }

  /** 下发目标关节角并等待真实 /robot/status 反馈到位（超时 10s）。
   *  供关节角直发回放（replayStep）与笛卡尔反解回放（replayCartesian）共用。 */
  async function runToTarget(index: number, targetRad: number[], label: string): Promise<boolean> {
    const arm = side.value === 'arm_L' ? 1 : 2
    message.value = `${label}第 ${index + 1} 行：命令已下发`
    const res = await send('manipulators_control', {
      arm, control_mode: 1, joint_angles: targetRad, velocity_pct: 10, acceleration_pct: 10,
    })
    if (!rosOk(res)) {
      message.value = `${label}第 ${index + 1} 行失败：协议返回 false`
      return false
    }
    const start = performance.now()
    while (performance.now() - start < 10000) {
      const status = arm === 1 ? robotStore.armL : robotStore.armR
      const reached = !status.moving && targetRad.every((target, i) =>
        Math.abs((status.joints[i] ?? 0) - target) < 0.5 * DEG2RAD)
      if (reached) {
        message.value = `${label}第 ${index + 1} 行到位`
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    message.value = `${label}第 ${index + 1} 行超时`
    return false
  }

  /** 关节角直发回放（原有路径，按记录的 j[0..6]）。 */
  async function replayStep(index: number): Promise<boolean> {
    const point = rows.value[index]
    if (!point) return false
    return runToTarget(index, point.j.map(v => v * DEG2RAD), '回放')
  }

  /** 笛卡尔单点执行（P-B 路线乙）：以该点 tool0 位姿经 6D IK 反解关节角下发。
   *  IK 不可用/未收敛时回退关节角直发。MOCK 阶段 Web 用自身 IK 模拟运动；
   *  真机阶段改由后端 cartesian_goto（SdkArmBackend::cartesianMove）接管。 */
  async function replayCartesian(index: number): Promise<boolean> {
    const point = rows.value[index]
    if (!point) return false
    const sideChar = side.value === 'arm_L' ? 'L' : 'R'
    const status = side.value === 'arm_L' ? robotStore.armL : robotStore.armR
    // 用当前实际关节角作 IK 初值（保证解在当前位形邻域，不跳变）
    const seed = status.joints.length >= 7
      ? status.joints.slice(0, 7)
      : point.j.map(v => v * DEG2RAD)
    let targetRad = seed
    if (hooks?.ik6d) {
      const solved = hooks.ik6d(
        sideChar,
        new THREE.Vector3(point.x, point.y, point.z),
        new THREE.Quaternion(point.qx, point.qy, point.qz, point.qw),
        [...seed],
      )
      // 只接受长度正确且全为有限值的结果（防 NaN 污染关节流）
      if (solved && solved.length === 7 && solved.every(v => Number.isFinite(v))) {
        targetRad = solved
        message.value = `笛卡尔执行第 ${index + 1} 行：IK 反解成功`
      }
    }
    return runToTarget(index, targetRad, '笛卡尔')
  }

  /** 等待当前臂到位（与 runToTarget 同判据：!moving 且 7 轴误差 <0.5°，超时 10s）。 */
  async function waitSettle(timeoutMs = 10000): Promise<boolean> {
    const arm = side.value === 'arm_L' ? robotStore.armL : robotStore.armR
    const start = performance.now()
    while (performance.now() - start < timeoutMs) {
      if (!arm.moving) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return false
  }

  /**
   * minimum-jerk 连续回放整列示教点（2026-09-04 M1 新增，设计 docs/sim-teach-loop-design.md）。
   *
   * 与单步回放（replayStep）的差异：
   *   - 单步：只把目标角一次下发（关节空间，Mock 限速跟随），适合逐点核对；
   *   - 整列：点与点之间按 minimum-jerk 五阶多项式（easeInOut）插值出中间帧，
   *     经 topic 流（stream）逐帧下发——平滑加速/减速，无轨迹点间的速度跳变，
   *     正是 useTeach 文件头"minimum-jerk 回放"设计本意（此前 trajectory.ts 无调用方）。
   *
   * 链路：每段插值 20 帧（约 0.4s @50Hz）→ 帧间线性叠加 ease 权重 →
   *       sendStream('manipulators_control', {arm, control_mode:1, joint_angles}) →
   *       /robot/human_extern_cmd_stream → comms → /arm/cmd → Mock 跟随。
   * 末尾追加一次 send（服务）确保终值精确到位（与拖动流"松手补发终值"同口径）。
   *
   * @param segFrames  每段插值帧数（默认 20；越大越平滑但回放越慢）
   * @returns 是否全部到位；任一段等待超时返回 false（不中断后续段）
   */
  async function replayAll(segFrames = 20): Promise<boolean> {
    const pts = rows.value
    if (pts.length < 2) {
      message.value = '整列回放需要至少 2 个示教点'
      return false
    }
    // 回放目标：关节角直发（与 replayStep 同口径；笛卡尔 IK 逐段反解留作后续增强）
    // —— 拖动示教采的本来就是关节空间点（j[0..6]），逐点反解反而引入场景 IK 误差。
    const arm = side.value === 'arm_L' ? 1 : 2
    message.value = `整列回放：${pts.length} 点，minimum-jerk 插值中`
    let allOk = true
    for (let i = 0; i < pts.length - 1; i++) {
      const from = pts[i].j.map(v => v * DEG2RAD)
      const to = pts[i + 1].j.map(v => v * DEG2RAD)
      // 逐帧插值下发：只发已变化的关节（未变化关节保持当前值即可，避免无谓刷流）
      for (let f = 0; f < segFrames; f++) {
        // easeInOut(t) ∈ [0,1]：t 归一化后沿 minimum-jerk 曲线推进，
        // 起点/终点速度为零 → 段间无速度跳变，仿人手臂手感。
        const t = f / (segFrames - 1)
        const w = easeInOut(t)
        const target = from.map((v, k) => v + (to[k] - v) * w)
        if (stream) {
          stream('manipulators_control', {
            arm, control_mode: 1,
            joint_angles: target, velocity_pct: 50, acceleration_pct: 50,
          })
        }
        // 无流通道（单测/降级）退化为低频 sleep——行为一致仅节奏变慢。
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    // 终值精确下发（走服务，确保回放终点在到达容差内）
    const last = pts[pts.length - 1].j.map(v => v * DEG2RAD)
    const res = await send('manipulators_control', {
      arm, control_mode: 1, joint_angles: last, velocity_pct: 10, acceleration_pct: 10,
    })
    if (!rosOk(res)) {
      message.value = '整列回放：终值下发失败'
      return false
    }
    if (!await waitSettle()) {
      message.value = '整列回放：终值等待到位超时'
      allOk = false
    } else {
      message.value = `整列回放完成：${pts.length} 点到位`
    }
    return allOk
  }

  async function triggerDemo(actionId: string, async = false): Promise<void> {
    demoRunning.value = true
    demoStatus.value = { actionId, running: true, result: null, message: '已下发', elapsedMs: 0 }
    const res = await send('demo_action_exec', { action_id: actionId, async })
    if (!rosOk(res)) {
      demoRunning.value = false
      demoStatus.value = { actionId, running: false, result: 1, message: '下发失败', elapsedMs: 0 }
    }
  }

  async function loadPresets(): Promise<void> {
    const data = await request('/api/gripper-presets', 'GET')
    presets.value = data.presets ?? {}
  }

  async function savePreset(name: string, preset: GripperPreset): Promise<void> {
    if (!name.trim()) throw new Error('预设名不能为空')
    presets.value = { ...presets.value, [name.trim()]: preset }
    await request('/api/gripper-presets', 'PUT', { presets: presets.value })
    message.value = `夹爪预设已保存：${name}`
  }

  /** 导出动作库 JSON（P-B）：把当前臂点集打包为单段动作库（含 config 默认字段），
   *  浏览器下载 action_library_<side>.json。多段/双臂点集/事件为后续增强。 */
  function exportActionLibrary(): void {
    const sideChar = side.value === 'arm_L' ? 'L' : 'R'
    const other = sideChar === 'L' ? 'R' : 'L'
    const baseConfig = { speed_pct: 50, acc_pct: 50, timeout_s: 10, blend_ratio: 0, sync_rule: 'index' as const }
    const library: ActionLibrary = {
      meta: { name: `${sideChar} 臂动作库`, version: '0.1.0', tool_frame: 'tool0', created_at: new Date().toISOString() },
      global_defaults: { ...baseConfig },
      segments: [{
        id: `seg_${sideChar.toLowerCase()}_${Date.now().toString(36)}`,
        name: `${sideChar} 臂示教段`,
        arms: [
          { side: sideChar, name: `${sideChar} 臂动作`, config: { ...baseConfig }, points: rows.value.map(p => ({ ...p })), mode_events: [] },
          { side: other, name: `${other} 臂动作`, config: { ...baseConfig }, points: [], mode_events: [] },
        ],
      }],
    }
    const blob = new Blob([JSON.stringify(library, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `action_library_${sideChar.toLowerCase()}.json`
    a.click()
    URL.revokeObjectURL(url)
    message.value = `动作库已导出：${rows.value.length} 点`
  }

  onUnmounted(stopSampling)

  return {
    // 2026-09-06：teachKind 对外暴露——App.vue 的退出 toast 与 3D Jog 启用判定
    //（isTeachActive 注入）都需要区分键盘踩点/人手拖动两条路径。
    side, teaching, teachKind, sampling, rows, selectedIndex, selectedPoint, message,
    lastError, previewArmJoint,
    demoRunning, demoStatus, presets,
    enterTeach, enterTeachKeyboard, exitTeach, captureManualPoint, deleteSelected, renameSelected,
    saveTeach, loadTeach, exportCsv, replayStep, replayCartesian, triggerDemo,
    replayAll,
    exportActionLibrary,
    loadPresets, savePreset,
    // SDK 能力补全（2026-08-31）：拖动空间 + 阻抗/力控 + Phase2/3 命令
    dragSpace, applyImpedance, applyForce, sendForceCmd,
    uploadPvt, gatherControl, setToolParams, getToolParams, saveToolParams,
    setPara, getPara, savePara, servoReset, downloadLog,
  }
}

export type TeachController = ReturnType<typeof useTeach>
