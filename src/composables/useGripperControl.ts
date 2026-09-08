/**
 * @file    useGripperControl.ts
 * @brief   夹爪命令编排：跟手性预览/节流/终值补发 + 力速位置命令 + 预置加载保存 + 反馈对账
 * @author Csihan
 * @date    2026-09-02
 *
 * 设计（App 拆分，2026-09-02）：
 *   - 从 App.vue 剥离夹爪全部编排（9 函数 + gripUi 草稿态 + gripDrag 会话 + 50ms 节流 +
 *     反馈对账 watch），行为原样迁移；
 *   - 跟手性三对策（2026-08-31 实测口径）内聚于此：
 *     B) 拖动中 3D 手指本地即时预览（0ms）；D) 下发 50ms 节流（20Hz）；反馈对账解除 active；
 *   - 依赖注入：命令出口（useCommandBus）/ 3D 驱动钩子 / busy / useTeach 预置存取。
 */

import { reactive, watch } from 'vue'
import { robotStore } from './useRobotStatus'
import { pctToM } from '../utils/gripperUnits'
import type { Ref } from 'vue'
import type { GripperPreset } from '../types/robot'

/** 夹爪控制依赖注入参数。 */
export interface GripperControlDeps {
  sendCommand: (type: string, content: any) => Promise<any>
  callService: (service: string, type: string, payload: any) => Promise<any>
  /** 3D 手指即时驱动（App 注入 robot3d 转发）。 */
  driveGripper: (side: 'L' | 'R', positionM: number) => void
  /** 通用 busy（预置加载期间禁其它写操作）。 */
  busy: Ref<boolean>
  /** 示教控制器（预置保存）。 */
  teach: { savePreset: (name: string, values: any) => Promise<any> }
}

/**
 * 夹爪 UI 草稿态：左右夹爪的力（force%）与速度（speed%）。
 * reactive 包裹以便子组件双向绑定时不丢响应；与 robotStore.gripL/R 中的
 * "当前实际值"分离，避免输入时立即覆盖硬件回读（防回拽的核心）。
 *
 * 默认值：force=30%、speed=50%（取经验值，避免新手一上来就全力夹紧）。
 */
const gripUi = reactive({
  L: { force: 30, speed: 50 },
  R: { force: 30, speed: 50 },
})
/**
 * 夹爪拖动会话（按爪分立）：每个爪一组会话状态。
 *  - preview: 用户拖动时的最新目标开度（%）。
 *  - timer:   节流定时器句柄；非 null 表示已有待发任务，下次 onChange 应合并。
 *  - active:  是否处于"用户正在拖动"期间（true 时压制反馈回值，避免回拽滑杆）。
 */
const gripDrag: Record<1 | 2, { preview: number; timer: number | null; active: boolean }> = {
  1: { preview: 0, timer: null, active: false },
  2: { preview: 0, timer: null, active: false },
}
/** 拖动中下发节流 20Hz（service RTT 仅 ~3ms，安全）。 */
const GRIP_SEND_INTERVAL_MS = 50

/** 创建夹爪控制器（原 App.vue 对应逻辑原样迁移）。 */
export function useGripperControl(deps: GripperControlDeps) {
  const { sendCommand, callService, busy, teach } = deps

/**
 * 本地预览驱动 3D 手指（不回落旧反馈，拖动中反馈被抑制）。
 * 与底盘 previewChassis 同款思路：UI 在用户拖动期间拥有"即时姿态权"。
 */
function previewGrip(idx: 1 | 2, pct: number) {
  gripDrag[idx].preview = pct
  gripDrag[idx].active = true
  const side = idx === 1 ? 'L' : 'R'
  // pctToM 把 0~100% 映射到协议米数（夹爪行程）；3D 用米为单位。
  deps.driveGripper(side, pctToM(pct))
}
/**
 * 节流下发（50ms 合并）：拖动中高频 onChange 只在窗口结束时发一次。
 * 内部维护一个待发定时器；连续触发只在最后一个 setTimeout 回调里读最新 preview。
 */
function throttleSendGrip(idx: 1 | 2, pct: number) {
  // 无论是否合并，都把"最新意图"写到会话状态里，保证定时器触发时拿的是终值。
  gripDrag[idx].preview = pct
  const d = gripDrag[idx]
  if (d.timer !== null) return   // 已有待发任务：本次合并进下一拍
  d.timer = window.setTimeout(() => {
    d.timer = null
    void setGripPosition(idx, d.preview)
  }, GRIP_SEND_INTERVAL_MS)
}
/**
 * 设置夹爪开度（百分位 → 米）。走 human_extern_cmd → gripper_control。
 * 同步带上当前 UI 草稿态的 force/speed，避免一边拖动位置一边改变力而出现卡顿。
 */
function setGripPosition(idx: 1 | 2, pct: number) {
  return sendCommand('gripper_control', {
    gripper: idx, cmd: 'set_position', value: pctToM(pct),
    force_pct: idx === 1 ? gripUi.L.force : gripUi.R.force,
    speed_pct: idx === 1 ? gripUi.L.speed : gripUi.R.speed,
  })
}
/**
 * 滑杆 onChange 入口（拖动中每帧触发）：本地预览 + 节流下发。
 * 预览走 0ms 即时反馈通道，下发走 50ms 节流服务通道，互不干扰。
 */
function onGripPositionInput(idx: 1 | 2, pct: number) {
  previewGrip(idx, pct)
  throttleSendGrip(idx, pct)
}
/**
 * 滑杆 change（松手）：取消挂起的节流定时器，立即补发终值。
 * active 标志保留为 true，由 watch 在 position 接近 preview 时清掉，
 * 让真实反馈重新接管显示（避免滑杆松手后"冻结"在预览值）。
 */
function onGripPositionCommit(idx: 1 | 2, pct: number) {
  const d = gripDrag[idx]
  if (d.timer !== null) { clearTimeout(d.timer); d.timer = null }   // 取消挂起节流，直接发终值
  d.preview = pct
  void setGripPosition(idx, pct)
  // 保持 active 直到反馈接管（watch 里 position 接近预览值时清 active）
}
/** 设置夹爪力（%）：先写本地 UI 草稿态，再下发命令（gripUi 是 single source of truth for UI）。 */
function setGripForce(idx: 1 | 2, pct: number) {
  if (idx === 1) gripUi.L.force = pct; else gripUi.R.force = pct
  return sendCommand('gripper_control', { gripper: idx, cmd: 'set_force', force_pct: pct })
}
/** 设置夹爪速度（%）：同上，更新 UI 草稿态 + 下发命令。 */
function setGripSpeed(idx: 1 | 2, pct: number) {
  if (idx === 1) gripUi.L.speed = pct; else gripUi.R.speed = pct
  return sendCommand('gripper_control', { gripper: idx, cmd: 'set_speed', speed_pct: pct })
}
/**
 * 通用夹爪命令（init / position / open / close 等都走这里）。
 * 例外：'clear_error' 不走 human_extern_cmd，而是直接调用底层内部服务（紧急通道）。
 *
 * @param idx   夹爪编号 1=左、2=右。
 * @param cmd   命令类型字符串。
 * @param extra 额外的命令负载字段（透传到 gripper_control.content）。
 */
async function gripCommand(idx: 1 | 2, cmd: string, extra: Record<string, unknown> = {}) {
  // comms 当前只经 human_extern_cmd 转发 init/position；清错保留既有内部服务入口。
  if (cmd === 'clear_error') {
    await callService(`/robot/internal/gripper/${idx === 1 ? 'L' : 'R'}/clear_error`, 'std_srvs/Trigger', {})
    return
  }
  await sendCommand('gripper_control', { gripper: idx, cmd, ...extra })
}
/**
 * 加载夹爪预置：力 → 速度 → 位置 顺序下发，避免力/速度未达目标就拖动导致打滑。
 * 全程置 busy=true 屏蔽其它写操作（防重入），用 try/finally 兜底释放。
 */
async function loadGripperPreset(idx: 1 | 2, preset: GripperPreset) {
  busy.value = true
  try {
    // 先把预置值写到本地 UI 草稿态，后续 3D 预览/其它 UI 会读到一致值。
    if (idx === 1) {
      gripUi.L.force = preset.force_pct
      gripUi.L.speed = preset.speed_pct
    } else {
      gripUi.R.force = preset.force_pct
      gripUi.R.speed = preset.speed_pct
    }
    // 顺序很重要：先固定力，再固定速度，最后执行位置动作，否则会出现"高速高力撞目标"。
    await setGripForce(idx, preset.force_pct)
    await setGripSpeed(idx, preset.speed_pct)
    await setGripPosition(idx, preset.position_pct)
  } finally {
    busy.value = false
  }
}
/**
 * 保存当前夹爪状态为命名预置。
 * 转换说明：position 单位是协议米（0~60mm），转百分比时乘 1000/60*100 = ×1666.66…，
 * 这里先乘 1000（mm）再除 60（行程上限）再乘 100（百分化）保持等价。
 */
async function saveGripperPreset(name: string, idx: 1 | 2) {
  // 把实际米数换算成百分比，UI 上下一次加载预置时直接用 percent 即可。
  const positionPct = Math.round((idx === 1 ? robotStore.gripL.position : robotStore.gripR.position) * 1000 / 60 * 100)
  const values = idx === 1
    ? { position_pct: positionPct, force_pct: gripUi.L.force, speed_pct: gripUi.L.speed }
    : { position_pct: positionPct, force_pct: gripUi.R.force, speed_pct: gripUi.R.speed }
  // 调 useTeach 保存预置到本地存储（IndexedDB / localStorage，由 useTeach 决定）。
  await teach.savePreset(name, values)
}

  // —— 反馈对账 watch：反馈接近预览值时解除 active，真实反馈重新接管显示 ——
// 夹爪开度 3D 跟随（夹爪驱动不发 /joint_states，前端把 GripperStatus.position
// 映射为 URDF prismatic 关节值，设置开度后模型手指实时跟随）。
// V1.3.2：拖动预览接管——本地预览值与反馈接近（到位容差 3%）时才让反馈接管，
// 防止 30Hz 反馈在拖动中把 3D 手指拽回旧值（与底盘 followChassis 同思路）。
watch(() => robotStore.gripL.position, v => {
  // 不在拖动态，或反馈已经追上预览值（容差 0.002m ≈ 0.2mm），就退出 preview 接管。
  if (!gripDrag[1].active || Math.abs(v - pctToM(gripDrag[1].preview)) < 0.002)
    gripDrag[1].active = false
  if (!gripDrag[1].active) deps.driveGripper?.('L', v)
})

watch(() => robotStore.gripR.position, v => {
  if (!gripDrag[2].active || Math.abs(v - pctToM(gripDrag[2].preview)) < 0.002)
    gripDrag[2].active = false
  if (!gripDrag[2].active) deps.driveGripper?.('R', v)
})

  return {
    gripUi, gripDrag,
    previewGrip, throttleSendGrip, setGripPosition, onGripPositionInput,
    onGripPositionCommit, setGripForce, setGripSpeed, gripCommand,
    loadGripperPreset, saveGripperPreset,
  }
}
