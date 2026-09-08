<script setup lang="ts">
/**
 * @file    App.vue
 * @brief   MARVIN 3D Web 示教大屏：3D 交互、Mock 安全门禁、示教与设备控制编排
 * @author Csihan
 * @date    2026-08-28
 *
 * 模块角色：
 *   - 整个 Web 示教大屏的根组件（单页应用骨架），负责把 ROS 通讯层、3D 视图层、
 *     状态层、各功能子组件组装起来，再向外发出 human_extern_cmd 服务调用。
 *   - 作为「命令唯一出口」sendCommand() 的所在地，配合 SIMULATION_ONLY 常量构成
 *     面向真机的第一道硬门禁（任何运动命令都必须经过此函数）。
 *
 * 安全口径：
 *   - SIMULATION_ONLY 是本轮回调的硬边界。所有会引发运动的 human_extern_cmd
 *     都先经过 sendCommand()；后续开放真机时必须在单独变更中设计授权、互锁和现场确认。
 *   - 连续型命令（拖动 / 滑条 / 头部 / 底盘）走 sendStream() → topic 流，避免 service
 *     出站在长会话下半开丢命令。
 *
 * 设计要点：
 *   - 模板布局：3D 视口占满 + 四边 HUD（顶部状态条 / 左右臂/爪状态 / 底条底盘/坞站）。
 *   - 状态管理：所有机器人状态统一收敛于 robotStore（composables/useRobotStatus.ts）。
 *   - 事件流：3D 选中 → selectedPart/selectedJoint 更新 → contextKey 计算 → 弹出侧栏面板。
 *
 * 2026-09-03：SIMULATION_ONLY 门禁值改由 dashboard.yaml（safety.simulation_only）配置，
 * 默认 true 与改造前一致；配置加载由 main.ts 在挂载前完成。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue'
// 上述导入说明：
// - computed: 派生响应式数据（如 kbName / contextKey / dragArms 等）。
// - onBeforeUnmount/onMounted: 组件挂载/卸载生命周期（注册订阅、清理定时器）。
// - reactive: 深响应式对象（gripUi、connector 等普通对象用 reactive 包裹）。
// - ref: 单值响应式容器（selectedPart、busy、chartLabels 等）。
// - watch: 监听某个 ref/reactive 变化并触发副作用（如底盘/头部跟随 3D 反馈）。
// - Ref: 复合类型 `robot3d` 中需要声明 Ref 包装的可读写对象。
import { useRos } from './composables/useRos'
// useRos: 封装 rosbridge WebSocket 连接、subscribe / callService / publish 等 API。
import { robotStore, startStatusSubscription, backendMode, robotName } from './composables/useRobotStatus'
// robotStore: 全局机器人状态（双臂、夹爪、头部、底盘、电量等）的 reactive 单例。
// startStatusSubscription(): 启动订阅 /robot/status 等话题，把数据写入 robotStore。
import { useCommandBus } from './composables/useCommandBus'
import { useGripperControl } from './composables/useGripperControl'
import { useTeach } from './composables/useTeach'
// useTeach: 示教与编排子模块（点位采样、单步回放、运行示例动作、保存/加载预置等）。
// useArmPlan: Web 全覆盖机械臂控制（协议 V1.0.9，2026-09-03）——
// 在线规划/双臂协同/运动学 IK-FK/场力控制/末端通信/系统控制 命令封装。
import { useArmPlan } from './composables/useArmPlan'
import type { JointDragCommand, SelectedPart } from './composables/useRobot3D'
// JointDragCommand: 3D 中拖动关节球的命令载荷类型（arm + 关节角数组）。
// SelectedPart: 3D 中选中的部位标识（arm_l / grip_r / head / chassis …）。
import { LIFT_MIN_MM, LIFT_MAX_MM, BEND_MIN_DEG, BEND_MAX_DEG } from './utils/chassisUnits'
// 底盘单位/行程常量：升降 mm 上下限、弯腰角度上下限，便于面板与命令双层钳位复用。
// pctToM: 夹爪开度百分比 ↔ 米单位的换算函数（与协议字段对齐）。
// GripperPreset: 夹爪预置点位的数据结构（名称 + 张开距离 + 力 + 速度）。
// 2026-09-03：运行配置（dashboard.yaml）——SIMULATION_ONLY 门禁值来源
import { getDashboardConfig } from './config/dashboardConfig'
import HeaderBar from './components/HeaderBar.vue'
import ArmPanel from './components/ArmPanel.vue'
import GripperPanel from './components/GripperPanel.vue'
import JointInspector from './components/JointInspector.vue'
import BottomDock from './components/BottomDock.vue'
import ArmStatusPanel from './components/ArmStatusPanel.vue'
import GripperStatusPanel from './components/GripperStatusPanel.vue'
import HeadStrip from './components/HeadStrip.vue'
import HelpGuide from './components/HelpGuide.vue'
import ChassisStrip from './components/ChassisStrip.vue'
import ChassisPanel from './components/ChassisPanel.vue'
import HeadPanel from './components/HeadPanel.vue'
// 上述组件是「职责单一」的子视图：标题栏 / 单臂面板 / 单爪面板 / 关节检查器 /
// 底部坞站 / 臂状态条 / 爪状态条 / 头状态条 / 帮助 / 底盘条 / 底盘面板 / 头部面板。

/**
 * 安全门禁总开关（仿真=仅 Mock）。
 * 2026-09-03：取值不再硬编码，改读 dashboard.yaml 的 safety.simulation_only（现场可配）。
 * 设为 false 时：
 *   - sendCommand / sendStream 全部短路返回（命令不会到达底层）。
 *   - resetAllArms 会要求 window.confirm 二次确认。
 * 注意：true→false = 放开命令下发，属于真机授权动作，必须单独评估
 * 授权/互锁/现场确认流程，不要只改一行配置就当作完成授权。
 */
const SIMULATION_ONLY = getDashboardConfig().safety.simulationOnly

// 注入 ROS 通讯桥：拿到的 4 个方法会贯穿整个组件。
// - connected: 当前是否连上 rosbridge（true 才能下发命令）。
// - subscribe: 订阅某个话题（返回退订函数）。
// - callService: 调用某个 ROS 服务（请求-响应，命令级）。
// - publish: 发布到某个话题（fire-and-forget，连续流场景）。
const { connected, subscribe, callService, publish } = useRos()

// 3D 视口 DOM 引用：把视口元素交给 useRobot3D 注入渲染器，
// 也用于后续鼠标坐标 ↔ 屏幕坐标的换算（projectPartToScreen）。
const viewportRef = ref<HTMLDivElement | null>(null)

// 顶部悬浮提示条 DOM 引用（选中部位/关节时的标签元素）。
const labelRef = ref<HTMLDivElement | null>(null)

// 右侧上下文面板的 DOM 引用：用于键盘 Esc 等快捷键聚焦/失焦判断。
const contextPanelRef = ref<HTMLElement | null>(null)

/** 3D 中当前选中的部位标识（如 'arm_l' / 'grip_r' / 'head' / 'torso'），null 表示无选中。 */
const selectedPart = ref<string | null>(null)

/** 3D 中当前选中的关节标识（如 'Joint3_L'），用于打开 JointInspector 与 kb-HUD。 */
const selectedJoint = ref<string | null>(null)

/** 聚焦模式：选中部位后，其它无关 HUD/标签淡出（级联样式 .focus-mode 的开关）。 */
const focusMode = ref(false)

/** 3D 模型加载完成的标志位（首屏 loading 蒙层以此为依据淡出）。 */
const modelLoaded = ref(false)

/** 3D 模型识别到的关节数量（用于状态条与调试诊断）。 */
const jointCount = ref(0)

/** 通用「忙碌」标志：示教采样、单步执行、回放等长流程开启时为 true，按钮禁用防重入。 */
const busy = ref(false)

/** 关节角度历史曲线的横轴标签（角度序号 0..N），由 setInterval 周期推进。 */
const chartLabels = ref<string[]>([])

/** 左臂最近 N 个采样点对应的关节角度数组（度），用于头部趋势图。 */
const chartLeft = ref<number[]>([])

/** 右臂最近 N 个采样点对应的关节角度数组（度），用于头部趋势图。 */
const chartRight = ref<number[]>([])

/**
 * 3D 选中部位 ↔ 侧栏面板之间的「连接线」几何信息：
 *   - visible: 是否显示连线。
 *   - x1/y1: 3D 中部位投影到屏幕的坐标。
 *   - x2/y2: 侧栏面板入口的坐标。
 * 用 reactive 是因为它是普通对象，无需 ref 的 .value。
 */
const connector = reactive({ visible: false, x1: 0, y1: 0, x2: 0, y2: 0 })
/**
 * 3D 视图层对外暴露的句柄（懒注入）。
 * 在 onMounted 中由 useRobot3D 初始化赋值；模板 / 命令函数通过可选链调用。
 * 之所以用 `let` 而不是 `ref` 是因为它是一组方法集合（无响应式需求）。
 */
let robot3d: {
  /** 把 /joint_states 推送过来的关节角度写入 3D 模型姿态。 */
  updateJoints: (msg: any) => void
  /** 当前 3D 选中部位（Ref 形式，组件可直接 .value 绑定）。 */
  selectedPart: Ref<SelectedPart | null>
  /** 聚焦模式 Ref（与本组件 focusMode 双向同步）。 */
  focusMode: Ref<boolean>
  /** 模型加载完成标志位 Ref。 */
  modelLoaded: Ref<boolean>
  /** 复位相机视角到默认机位（HeaderBar 复位按钮 / Esc 退出时调用）。可选。 */
  resetView?: () => void
  /** 各关节当前角度（rad）的响应式字典，给 UI 取值用。 */
  jointPositions: Ref<Record<string, number>>
  /** 把 3D 中指定部位（link）投影到屏幕像素坐标，用于 HUD 标签定位。 */
  projectPartToScreen: (partId: string) => { x: number; y: number } | null
  /** 即时预览某个关节的目标角度（不等待 ROS 反馈，松手立刻投影）。 */
  previewJointTarget?: (jointName: string, angleRad: number) => void
  /** 即时驱动夹爪模型的开度（米），与命令下发同步展示。 */
  driveGripper?: (side: 'L' | 'R', positionM: number) => void
  /** 底盘 3D 即时预览（面板/拖动下发用，无抑制窗口）。 */
  previewChassis?: (axis: 'lift' | 'bend', value: number) => void
  /** 底盘反馈跟随（watch 专用）：拖动/松手缓冲期内丢弃反馈防回拽（2026-08-30）。 */
  followChassis?: (axis: 'lift' | 'bend', value: number) => void
  /** 头部 3D 即时预览（HeadPanel 下发/拖动用）。 */
  previewHead?: (axis: 'yaw' | 'pitch', deg: number) => void
  /** 头部反馈跟随（watch 专用）：拖动/缓冲期内丢弃反馈防回拽（2026-08-30）。 */
  followHead?: (axis: 'yaw' | 'pitch', deg: number) => void
  /** 清除键盘微调选中（Esc/关面板/退出拖动时调用，防面板关了 W/S 仍生效）。 */
  clearKbSelection?: () => void
  /** 各关节限位（URDF rad 域），面板与拖动钳位使用。 */
  jointLimits: Ref<Record<string, { min: number; max: number }>>
  /** P-B：FK 正解（tool0 世界位姿，踩点填 xyz/q）。 */
  computeTool0?: (side: 'L' | 'R') => { pos: import('three').Vector3; quat: import('three').Quaternion } | null
  /** P-B：6D IK（笛卡尔目标→关节角，点选执行）。 */
  solveTool0IK6D?: (side: 'L' | 'R', targetPos: import('three').Vector3, targetQuat: import('three').Quaternion, angles: number[]) => number[]
} | null = null

/** 顶部关节角度历史曲线的定时器句柄（每 200ms 推一帧）。 */
let chartTimer: ReturnType<typeof setInterval> | null = null

/** 3D ↔ 侧栏面板「连接线」位置刷新定时器（动画过程中持续更新几何）。 */
let connectorTimer: ReturnType<typeof setInterval> | null = null

/**
 * 注入示教编排器。
 * 入参：
 *   - sendCommand: 让 useTeach 也能走同一道硬门禁。
 *   - subscribe: 示教需要订阅 /teach_status 等话题来更新采样/单步状态。
 *   - { fk, ik6d }: P-B 计划点位所需的正解/逆解回调。
 *     注意：robot3d 在 onMounted 之后才赋值，因此这里用箭头函数延迟读取全局 robot3d。
 */

// ─── P1 拆分（2026-09-02）：命令总线与夹爪编排下沉 composables（行为零变化）───
// useCommandBus：sendCommand/sendStream/streamDragCommand（双门禁 + msgId/caller 连续性）；
// useGripperControl：夹爪 9 函数 + gripUi/gripDrag 会话 + 反馈对账 watch（teach 之后装配）。
// 模板绑定与子组件接口不变——此处仅装配（deps 注入）+ 同名薄转发。
const commandBus = useCommandBus({
  simulationOnly: () => SIMULATION_ONLY,
  connected, callService, publish,
})
const sendCommand = commandBus.sendCommand.bind(commandBus)
const sendStream = commandBus.sendStream.bind(commandBus)
const streamDragCommand = commandBus.streamDragCommand.bind(commandBus)
// 2026-09-04（SIM-TEACH-LOOP-M1）：useTeach 注入 topic 流发送器——
// minimum-jerk 整列回放逐帧下发必须走 /human_extern_cmd_stream（fire-and-forget），
// service 往返延迟会导致帧间卡顿；与拖动流（streamDragCommand）同通道同 msgId 序列。
const teach = useTeach(sendCommand, subscribe, {
  // P-B 注入 FK/IK（来自 useRobot3D，onMounted 才初始化，故用箭头延迟取全局 robot3d）
  fk: side => robot3d?.computeTool0?.(side) ?? null,
  ik6d: (side, pos, quat, angles) => robot3d?.solveTool0IK6D?.(side, pos, quat, angles) ?? angles,
}, sendStream)

// Web 全覆盖机械臂控制（协议 V1.0.9，2026-09-03）：
// 在线规划/双臂协同/运动学 IK-FK/场力控制/末端通信/系统控制 命令封装
const armPlan = useArmPlan(sendCommand, subscribe)

const gripperCtl = useGripperControl({
  sendCommand, callService,
  driveGripper: (side, positionM) => robot3d?.driveGripper?.(side, positionM),
  busy, teach,
})
const { gripUi, gripDrag } = gripperCtl
const setGripPosition = gripperCtl.setGripPosition.bind(gripperCtl)
const onGripPositionInput = gripperCtl.onGripPositionInput.bind(gripperCtl)
const onGripPositionCommit = gripperCtl.onGripPositionCommit.bind(gripperCtl)
const setGripForce = gripperCtl.setGripForce.bind(gripperCtl)
const setGripSpeed = gripperCtl.setGripSpeed.bind(gripperCtl)
const gripCommand = gripperCtl.gripCommand.bind(gripperCtl)
const loadGripperPreset = gripperCtl.loadGripperPreset.bind(gripperCtl)
const saveGripperPreset = gripperCtl.saveGripperPreset.bind(gripperCtl)


/** 视图复位（包装以避免模板对 let 变量的类型收窄误报）。 */
function reset3dView() { robot3d?.resetView?.() }

/** 全局提示浮层（2026-08-29）：退出拖动/急停等状态变化的轻量可见反馈。 */
const toast = ref('')
/** toast 自动消失定时器句柄（连续触发时复用，避免叠加）。 */
let toastTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 显示一条屏幕底部 toast 提示。
 * @param msg  提示文案。
 * @param ms   自动消失延时，默认 2.2s。
 */
function showToast(msg: string, ms = 2200) {
  toast.value = msg
  // 重置定时器：新提示立即替换旧提示，避免短时间多次触发后旧提示"闪现"。
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.value = '' }, ms)
}

/** 操作指南浮层开关（右上角 ? 帮助按钮 → HelpGuide.vue 全屏指南）。 */
const helpOpen = ref(false)

// 键盘微调 HUD：选中关节名规范化为「R J3」样式 + 当前角度（用于屏幕上方提示条）。
// 例：'Joint3_L' → 'L J3'（左臂第 3 关节），符合"画面左侧是机器人左臂"的视觉方位（正面视角实测投影）。
const kbName = computed(() => selectedJoint.value?.replace(/^Joint(\d)_([LR])$/, '$2 J$1') ?? '')
/**
  // 从 'Joint3_L' 解析出关节索引 2（0-based），用于在 robotStore.armL.joints 数组中取当前角度。
  // 未选中或格式不符时返回 -1。
  */
const kbIndex = computed(() => {
  if (!selectedJoint.value) return -1
  const m = selectedJoint.value.match(/^Joint(\d)/)
  return m ? Number(m[1]) - 1 : -1
})
/**
  // 当前键盘微调作用的目标臂（来自 selectedJoint 的 '_L'/'_R' 后缀）。
  // kb-HUD 实时显示当前角度，kbArm 决定取左臂还是右臂的 joint 数组。
  */
const kbArm = computed(() => selectedJoint.value?.endsWith('_L') ? robotStore.armL : robotStore.armR)
/** 把弧度转成保留 1 位小数的度数字符串，便于 UI 紧凑显示。 */
function fmtDeg(v: number): number { return Number((v * 180 / Math.PI).toFixed(1)) }

/**
 * JointInspector 用的目标臂：选中关节时返回对应臂的 store，否则任一臂都可（默认 L）。
 * 与 kbArm 逻辑一致，单独命名便于 JointInspector 通过 prop 注入。
 */
const selectedArm = computed(() => selectedJoint.value?.endsWith('_L') ? robotStore.armL : robotStore.armR)

// ── 键盘笛卡尔 Jog HUD（2026-09-05 任务 TEACH-KEYBOARD-JOG）──
// 步长档位（1/2/3）与激活态由 3D 内 Jog 状态机经 onJogStateChange 上报；
// HUD 展示条件：示教语境（任一臂 M4 协作释放）下常驻显示，方便操作员看档位。
const jogStepLevel = ref<1 | 2 | 3>(2)        // 默认常规档
const jogActiveFlag = ref(false)              // 是否按住运动键（高亮提示）
/** 当前档位的 HUD 标签（与 jogCartesian.JOG_STEPS 对齐，避免双份文案漂移） */
const jogStepLabel = computed(() => {
  const map: Record<number, string> = { 1: '精调 2mm/0.5°', 2: '常规 10mm/2°', 3: '大步 30mm/5°' }
  return map[jogStepLevel.value] ?? '常规 10mm/2°'
})
/** Jog 档位快捷键 HUD 提示（数字键切换）。判定逻辑见 dragArms 定义（后移至
 *  该处之下，引用时序安全）；示教语境 = 任一臂 M4 协作释放 或 示教前端态。 */
// 2026-08-29 HUD 重构：顶部不再展示 CONTEXT 文案，部位上下文改由 3D 选中联动呈现。
/**
 * 计算「当前应展示哪个上下文面板」的 key：
 *   - 选中关节 → 'joint'（JointInspector）。
 *   - 选中底盘机构 link（如 'torso'） → 'chassis'（ChassisPanel）。
 *   - 否则透传 selectedPart（arm_l / arm_r / grip_l / grip_r / head 等）。
 * 模板用 v-else-if 链依次匹配对应的子组件。
 */
const contextKey = computed(() => {
  if (selectedJoint.value) return 'joint'
  // 底盘机构（升降 torso_lift/torso_pitch 等 link）→ 底盘面板；底条高亮已同时认两者的 active。
  if (selectedPart.value === 'torso') return 'chassis'
  return selectedPart.value
})

/**
 * 单关节点动命令（ArmPanel 滑条/按钮 → human_extern_cmd）。
 *
 * @param side  哪条臂：'L' / 'R'。
 * @param joint 0-based 关节索引（0=J1, 6=J7）。
 * @param deg   目标角度（度，浮点）。
 *
 * 行为：先用当前其它 6 个关节角度填充，保持 7 维数组，下发 manipulators_control。
 * 3D 预览与 topic 流见函数内注释。
 */
function jogArm(side: 'L' | 'R', joint: number, deg: number) {
  // 选臂 store：取当前 7 维关节角快照，未到位的位置补 0。
  const arm = side === 'L' ? robotStore.armL : robotStore.armR
  // UI 是度、协议是弧度：必须换算，否则机械臂会按"X 度"当"X 弧度"执行。
  const rad = deg * Math.PI / 180
  // 构造完整 7 维目标角数组（要动的关节用 rad，其余保持现状）。
  const angles = Array.from({ length: 7 }, (_, i) => i === joint ? rad : arm.joints[i] ?? 0)
  // 3D 即时预览（2026-08-30 用户第六轮#4）：J1~J7 滑条松手即投影到模型，
  // 并 registerPending 抑制反馈回弹——此前只有 Inspector 的 setJoint 有预览，
  // ArmPanel 滑条下发后模型要等 ROS 反馈才动，现场观感"滑条没生效"。
  robot3d?.previewJointTarget?.(`Joint${joint + 1}_${side}`, rad)
  // 2026-08-30（用户第八轮#3）：滑条点动改走 topic 流（fire-and-forget）——
  // service 出站在长会话下会半开丢命令；velocity 10→50 提升跟随体感。
  sendStream('manipulators_control', {
    arm: side === 'L' ? 1 : 2, control_mode: 1,
    joint_angles: angles, velocity_pct: 50, acceleration_pct: 50,
  })
}

// —— 夹爪指令（V1.3.2 跟手性优化：本地即时预览 + 50ms 节流 + 松手终值）——
// 实测口径（2026-08-31）：service RTT ~3ms、命令生效 ~33ms、反馈粒度原 100ms；
// 手感延迟主体=反馈粒度与滑杆高频 onChange。对策：
//   B) 滑杆拖动中 3D 手指本地即时预览（0ms），反馈回值在拖动中不覆盖预览；
//   D) 下发按 50ms 节流（20Hz），松手立即补发终值——遵守"下发=服务"口径；
// 反馈频率已由驱动侧 10Hz→30Hz（kPollDivModbus=1），三管齐下消除顿挫感。


/**
 * 单步回放当前选中的轨迹点（P-B：优先笛卡尔）。
 * 走 teach.replayCartesian 而非 teach.replayJoint：若点位含 6D 目标（xyz+q），
 * 使用 6D IK 反解为关节角；IK 不可用时内部自动回退到关节角直发。
 */
async function replaySelected() {
  if (teach.selectedIndex.value === null || busy.value) return
  busy.value = true
  try {
    // P-B：单步执行优先走笛卡尔（tool0 位姿 → 6D IK 反解），IK 不可用自动回退关节角直发
    await teach.replayCartesian(teach.selectedIndex.value)
  } finally {
    busy.value = false
  }
}

/** 整列 minimum-jerk 连续回放（2026-09-04 M1，设计 docs/sim-teach-loop-design.md）：
 *  把运动表全部示教点按 easeInOut 曲线逐帧经 topic 流下发，平滑加速-减速执行。
 *  无选中点也可执行（整列回放不依赖 selectedIndex）。 */
async function replayAllMotion() {
  if (busy.value) return
  busy.value = true
  try {
    await teach.replayAll()
  } finally {
    busy.value = false
  }
}

/** 单臂急停（走内部服务，不走 human_extern_cmd）。 */
function stopArm(side: 'L' | 'R') {
  return callService('/robot/internal/arm/emg_stop', 'robot_core_msgs/ArmEmgStop', { arm_id: side })
}

/** 任一臂急停/故障锁定 → 头部与底部 E-STOP 按钮切绿色 RESET 态（2026-08-29）。 */
const anyLocked = computed(() =>
  robotStore.armL.estop || robotStore.armR.estop ||
  robotStore.armL.fault || robotStore.armR.fault)

/** 底盘行走/转向电机故障数（2026-09-05 I6）：供右上告警徽标统计——任一
 *  行走/转向电机错误码或状态码非零计 1；升降/弯腰不在此列（条上已红显，
 *  避免徽标杂讯），聚焦"会跑/会打方向"的 8 台轮系电机。 */
const wheelFaultCount = computed(() =>
  [...robotStore.chassis.wheels, ...robotStore.chassis.steers]
    .filter(m => m.errorCode !== 0 || m.statusCode !== 0).length)

/** 处于零力拖动(M4)且未锁定的臂——驱动"拖动模式常驻浮条"与 Esc 退出。
 *  状态以服务端 /robot/status 回显为唯一事实源：刷新页面后自动对齐真实状态，
 *  根治"teaching 前端态刷新即丢、服务端还在 M4"的界面-机器脱节问题（用户反馈#5）。 */
const dragArms = computed<Array<'L' | 'R'>>(() => {
  const out: Array<'L' | 'R'> = []
  if (robotStore.armL.mode === 4 && !robotStore.armL.estop && !robotStore.armL.fault) out.push('L')
  if (robotStore.armR.mode === 4 && !robotStore.armR.estop && !robotStore.armR.fault) out.push('R')
  return out
})

/** 键盘笛卡尔 Jog HUD 展示条件（2026-09-05）：示教语境 = 任一臂 M4 协作释放
 *  （dragArms 非空）或 示教前端态（teach.teaching 激活），此时常驻显示档位。 */
const jogShow = computed(() => dragArms.value.length > 0 || teach.teaching.value)

/** 统一退出拖动：示教采样 + 服务端 M4 一起处理，并给出可见反馈。
 *  2026-08-29 修复：此前只按 dragArms（服务端 mode=4 回显）退出，示教面板的
 *  teaching/采样状态不同步，导致"按 Esc 后示教仍显示采样中/退不出"的错觉。 */
async function exitDragMode() {
  let exited = false
  if (teach.teaching.value) {
    await teach.exitTeach().catch(() => undefined)
    exited = true
  }
  if (dragArms.value.length) {
    dragArms.value.forEach(side => setArmMode(side, 1))
    exited = true
  }
  robot3d?.clearKbSelection?.()   // 2026-08-30 第七轮#3：退出拖动同时清键盘选中，防残留控制
  if (exited) showToast('已退出协作释放(RELEASE)')
  else closeContext()
}

/** E-STOP 双态的恢复路径：双臂清错 + 重切位置模式（与侧栏"软急停恢复"同链路）。
 *  真机安全口径：仿真单击直接恢复；真机（SIMULATION_ONLY=false）弹二次确认。 */
async function resetAllArms() {
  if (!SIMULATION_ONLY && !window.confirm('确认恢复双臂？请现场确认无人员/干涉后继续。')) return
  await clearArmError()
}

/** 清错 + 双臂切回位置模式（M1）。 */
async function clearArmError() {
  await callService('/robot/internal/arm/clear_error', 'robot_core_msgs/ArmClearError', {})
  // Mock 驱动清错只回 IDLE；Web 操作前必须重新切位置模式，否则运动命令仍被状态机拒绝。
  await sendCommand('manipulators_control', { arm: 1, mode_switch: { state: 1 } })
  await sendCommand('manipulators_control', { arm: 2, mode_switch: { state: 1 } })
}

function closeContext() {
  robot3d?.clearKbSelection?.()   // 2026-08-30 第七轮#3：关面板必须同时清键盘选中，
  robot3d?.resetView?.()          // 否则 kbSelected 残留 → W/S 仍驱动已关闭的关节
}

/**
 * Inspector 单关节角度下发（与 jogArm 的差异：可指定 chain=true 联动下发下游关节）。
 *
 * @param side       左/右臂。
 * @param jointIndex 0-based 关节索引。
 * @param deg        目标角度（度）。
 * @param chain      是否联动下发该关节之后的所有关节（用于沿链微调）。
 */
function setJoint(side: 'L' | 'R', jointIndex: number, deg: number, chain = false) {
  const arm = side === 'L' ? robotStore.armL : robotStore.armR
  // chain=true 时影响 jointIndex 之后的所有关节（含自己）；否则只影响目标关节。
  const affected = chain ? Array.from({ length: 7 }, (_, i) => i).filter(i => i >= jointIndex) : [jointIndex]
  const angles = Array.from({ length: 7 }, (_, i) => affected.includes(i) ? deg * Math.PI / 180 : arm.joints[i] ?? 0)
  // 3D 即时预览所有受影响的关节（联动模式时多个关节同步投影）。
  affected.forEach(i => robot3d?.previewJointTarget?.(`Joint${i + 1}_${side}`, deg * Math.PI / 180))
  // 同步更新示教编排器内部的"预览姿态"，回放/列表能立即看到联动结果。
  teach.previewArmJoint(side, jointIndex, deg)
  // 2026-08-30（用户第八轮#3）：Inspector 滑条同改 topic 流 + velocity 50
  sendStream('manipulators_control', {
    arm: side === 'L' ? 1 : 2, control_mode: 1,
    joint_angles: angles, velocity_pct: 50, acceleration_pct: 50,
  })
}

/** 切臂运行模式：state 见 robot_core_msgs（1=位置 M1 / 4=零力拖动 M4 等）。 */
function setArmMode(side: 'L' | 'R', state: number) {
  // 2026-09-02（零力拖动口径）：M4 带拖动空间 6（RELEASE 零力/重力补偿）——
  // comms 一站式走 /arm/set_drag（内部按 SDK 序列先复位 state=0 再进 RELEASE，
  // 真零力悬浮、拖到哪停到哪）。此前不带 drag_space 落入纯 set_mode 路径，
  // 被后端重定向为关节阻抗拖动（有回中力，非零重力）。阻抗拖动（1~5）用示教面板下拉。
  return sendCommand('manipulators_control', {
    arm: side === 'L' ? 1 : 2,
    mode_switch: state === 4 ? { state: 4, drag_space: 6 } : { state },
  })
}

/** 单臂 HOME（2026-08-29）：angles 为 Web 设置的自定义 home(rad)；null = yaml 标定默认。 */
function armHome(side: 'L' | 'R', angles: number[] | null) {
  return callService('/robot/internal/arm/home', 'robot_core_msgs/ArmHome', {
    arm_id: side === 'L' ? 1 : 2,
    joint_angles: angles ?? [],
  })
}

/**
 * 升降控制（2026-08-29 底盘面板）：mm（绝对高度）→ platform_control{z}（m）。
 * 行程 903.3~1453.3mm 来自协议解析层注释（真机标定值）；comms 只下发 z 轴，
 * 不会把底盘 x/y 开动。双重钳位：面板组件已钳一次，此处兜底。
 */
function liftTo(mm: number) {
  const clamped = Math.min(Math.max(mm, LIFT_MIN_MM), LIFT_MAX_MM)
  robot3d?.previewChassis?.('lift', clamped)          // 3D 本地即时预览
  sendStream('platform_control', { z: clamped / 1000 })   // 2026-08-30 改 topic 流
}

/**
 * 弯腰控制（2026-08-29）：deg → motor_control[{motor_type:2, target_angle}]。
 * motor_type=2 → comms 映射 "torso" → motor_driver 弯腰模块（deg 域）。
 * 限位 ±90°（URDF torso_pitch_joint ±1.5708rad）。
 */
function bendTo(deg: number) {
  const clamped = Math.min(Math.max(deg, BEND_MIN_DEG), BEND_MAX_DEG)
  robot3d?.previewChassis?.('bend', clamped)          // 3D 本地即时预览
  sendStream('motor_control', {                        // 2026-08-30 改 topic 流
    motor_control: [{ motor_type: 2, target_angle: clamped }],
  })
}

/** 3D 底盘控制球拖动 → 命令（120ms 节流，与关节球 30Hz 流区分：底盘是低频定位） */
let lastChassisSend = 0
function onChassisCommand(cmd: { axis: 'lift' | 'bend'; value: number }) {
  const now = performance.now()
  if (now - lastChassisSend < 120) return
  lastChassisSend = now
  if (cmd.axis === 'lift') liftTo(cmd.value)
  else bendTo(cmd.value)
}

/**
 * 头部控制（2026-08-30 用户第六轮#1）：yaw=motor_type 1（comms "head"）、
 * pitch=motor_type 3（comms "head_pitch"），deg 域，URDF 限位均 ±90°。
 * 双重钳位（面板已钳一次）→ 3D 本地即时预览 → human_extern_cmd 下发。
 * 2026-08-30 第七轮#2：同一出口接 3D 头部控制球（onHeadCommand，3D 内已 120ms 节流）。
 */
function headYawTo(deg: number) {
  const clamped = Math.min(Math.max(deg, -90), 90)
  robot3d?.previewHead?.('yaw', clamped)
  sendStream('motor_control', {                        // 2026-08-30 改 topic 流
    motor_control: [{ motor_type: 1, target_angle: clamped }],
  })
}
function headPitchTo(deg: number) {
  const clamped = Math.min(Math.max(deg, -90), 90)
  robot3d?.previewHead?.('pitch', clamped)
  sendStream('motor_control', {                        // 2026-08-30 改 topic 流
    motor_control: [{ motor_type: 3, target_angle: clamped }],
  })
}
/** 3D 头部球拖动 → 命令（3D 内部已节流 120ms，此处直接分发） */
function onHeadCommand(cmd: { axis: 'yaw' | 'pitch'; value: number }) {
  if (cmd.axis === 'yaw') headYawTo(cmd.value)
  else headPitchTo(cmd.value)
}

/**
 * 侧面板真实存在的上下文集合：只有这些才画「面板 → 3D 锚点」连接线。
 * chassis/torso/head 没有侧面板（信息在底部/顶部 strip，选中时 strip 已高亮），
 * 此前 context-panel 外壳对它们渲染成空的 420px div，updateConnector 用空矩形
 * 算起点 → 虚线从左上角空面板位置拉到 3D 锚点，看起来像"控制面板飞出场景"
 * （用户第五轮反馈，2026-08-29 修复）。
 * 底盘例外（2026-08-29）：新增 ChassisPanel 后 chassis（含 torso 机构映射）已有面板。
 * 头部例外（2026-08-30）：新增 HeadPanel，点 3D 头部出摇头/点头控制。
 */
const PANEL_PARTS = new Set(['joint', 'arm_l', 'arm_r', 'grip_l', 'grip_r', 'chassis', 'head'])

/**
 * 重算并刷新 3D ↔ 侧栏面板之间的连接线几何。
 * 触发时机：3D 部位变化、关节变化、定时器 80ms（持续贴合相机/UI 移动）。
 */
function updateConnector() {
  const ck = contextKey.value
  const part = selectedPart.value
  // 任一前置不满足时关闭连线（无焦点 / 无选中部位 / 无面板 / 不在白名单 / 3D 未挂载）。
  if (!focusMode.value || !part || !ck || !PANEL_PARTS.has(ck) || !robot3d) {
    connector.visible = false
    return
  }
  // 把 3D 中部位投影到屏幕像素；若部件被相机转到背面则返回 null，也关闭连线。
  const point = robot3d.projectPartToScreen(part)
  if (!point) {
    connector.visible = false
    return
  }
  const source = contextPanelRef.value
  if (!source) return
  const rect = source.getBoundingClientRect()
  // 双保险：面板 transition 进出瞬间或空外壳时 rect 尺寸≈0，起点会落到左上角
  if (rect.width < 40 || rect.height < 40) {
    connector.visible = false
    return
  }
  // 锚点钳制在视口内：部件被转到屏幕外时线不能跟出 3D 场景
  // x1/y1 = 面板右边缘外 6px 中点；x2/y2 = 部位投影钳制到屏幕内。
  connector.x1 = rect.right + 6
  connector.y1 = rect.top + rect.height / 2
  connector.x2 = Math.min(Math.max(point.x, 8), window.innerWidth - 8)
  connector.y2 = Math.min(Math.max(point.y, 8), window.innerHeight - 8)
  connector.visible = true
}

/**
 * 全局键盘处理（F12 / Esc）。
 * @param event 浏览器 keydown 事件。
 *
 * 设计：F12 永远等于"双臂急停"（兜底物理按钮缺失的应急路径）。
 *      Esc 按优先级处理三层 UI 状态。
 */
function onGlobalKey(event: KeyboardEvent) {
  if (event.key === 'F12') {
    event.preventDefault()
    callService('/robot/internal/arm/emg_stop', 'robot_core_msgs/ArmEmgStop', {})
  }
  if (event.key === 'Escape') {
    // Esc 三优先级：① 关闭操作指南 ② 退出拖动（服务端 M4 或示教采样） ③ 关闭上下文卡
    if (helpOpen.value) { helpOpen.value = false; return }
    if (dragArms.value.length || teach.teaching.value) { exitDragMode(); return }
    closeContext()
  }
}

/**
 * 组件挂载入口：依次完成 ROS 状态订阅、3D 模块懒加载、UI watch 接线、周期任务启动。
 *
 * 关键顺序：
 *   1. 先 startStatusSubscription：让 robotStore 尽快收到首帧 /robot/status，
 *      后续 ArmStatus / GripStatus / Head / Chassis 面板才不会全 0。
 *   2. 订阅 /joint_states 写回 robotStore.armL/armR.joints，并把关节角推到 3D。
 *   3. 注册全局键盘。
 *   4. 等 500ms 让 Vue/3D 渲染层稳定，再动态 import useRobot3D（启动 Three.js 较慢）。
 *   5. 注册若干 watch（夹爪跟随 / 底盘跟随 / 头部跟随）。
 *   6. 启动两个周期任务：关节趋势采样（500ms）、连接线几何刷新（80ms）。
 *   7. 异步加载示教预置（失败也不阻塞 UI）。
 */
onMounted(async () => {
  // 1) 启动 /robot/status 等状态话题订阅，把数据泵入 robotStore。
  startStatusSubscription(subscribe)
  // 1.5) 后端模式探测（V1.4.6，只读诊断不经命令门禁）：get_version 的 robot_name
  //  判定 MOCK/真机——mock 固定回 mock-marvin，真机返回固件名。失败保持 unknown 重试一次。
  const probeBackend = async () => {
    try {
      const vr: any = await callService('/robot/internal/arm/get_version',
                                        'robot_core_msgs/ArmGetVersion', { arm_id: 0 })
      const okFlag = vr?.success ?? vr?.values?.success
      if (okFlag) {
        const name = String(vr?.robot_name ?? vr?.values?.robot_name ?? '')
        robotName.value = name
        backendMode.value = /mock/i.test(name) ? 'mock' : 'real'
      }
    } catch { /* 服务未就绪：保持 unknown，兜底重试 */ }
  }
  await probeBackend()
  if (backendMode.value === 'unknown') setTimeout(probeBackend, 3500)
  // 2) 关节状态话题：1）同步给 3D 模型；2）按 JointX_L/R 命名规范写回 store.joints。
  //    2026-09-05 修复：真机/仿真反馈都在 /robot/internal/arm/joint_states（arm_driver_node
  //    StatusBridge 发布，ArmRosNode.cpp:168 ns+"/joint_states"）；原订阅 /joint_states(全局)
  //    只收到 joint_state_publisher_gui 等演示源的全零/缺失数据 → 面板有数而 3D 模型不动。
  //    现对齐到真实数据源，3D 模型即随 home [90,90,...] 显示"垂直向下"，与真机一致。
  subscribe('/robot/internal/arm/joint_states', 'sensor_msgs/JointState', (msg: any) => {
    // 顺带记录 3D 识别到的关节数量（调试诊断用）。
    jointCount.value = msg.name?.length ?? 0
    // 把整个 JointState 推给 3D，3D 内部按 name→URDF 关节匹配后驱动模型。
    robot3d?.updateJoints(msg)
    // ArmStatus 的 joints 是面板/Inspector 的唯一真实反馈源；3D 内部预览只用于抑制拖动回弹。
    msg.name?.forEach((name: string, i: number) => {
      // 只处理命名规范的 7 个主臂关节（Joint1_L ~ Joint7_R），底盘/头部等关节不进这里。
      if (/^Joint[1-7]_[LR]$/.test(name)) {
        const target = name.endsWith('_L') ? robotStore.armL : robotStore.armR
        const index = Number(name.match(/^Joint(\d)/)?.[1] ?? 1) - 1
        target.joints[index] = msg.position?.[i] ?? target.joints[index] ?? 0
      }
    })
  })
  // 3) 注册全局键盘（F12 急停 / Esc 三优先级）。
  window.addEventListener('keydown', onGlobalKey)
  // 4) 等 500ms 让渲染稳定，再懒加载 useRobot3D（Three.js 体积大，按需加载）。
  await new Promise(resolve => setTimeout(resolve, 500))
  if (viewportRef.value && labelRef.value) {
    const module = await import('./composables/useRobot3D')
    // 初始化 3D 场景：把视口 + 2D label 层元素交给 useRobot3D，挂上各事件回调。
    const scene3d = module.useRobot3D(viewportRef.value, labelRef.value, {
      onJointCommand: (command: JointDragCommand) => {
        // 2026-08-29：拖动目标改走 topic 流（见 streamDragCommand），service call 弃用
        streamDragCommand(command)
      },
      onJointSelect: name => { selectedJoint.value = name },
      onPartSelect: id => { selectedJoint.value = null; selectedPart.value = id },
      onReset: () => { selectedJoint.value = null; selectedPart.value = null },
      // 键盘 Space → 当前选中臂 HOME（yaml 标定角度）
      onHomeRequest: side => armHome(side, null),
      // 底盘控制球/面板命令出口（内部 120ms 节流；升降=platform_control.z、弯腰=motor_control）
      onChassisCommand: onChassisCommand,
      // 头部控制球命令出口（2026-08-30 第七轮#2；3D 内部 120ms 节流，motor_type 1/3）
      onHeadCommand: onHeadCommand,
      // 键盘笛卡尔 Jog 状态上报（2026-09-05）：步长档位/激活态 → HUD
      onJogStateChange: s => {
        // s.stepLevel 由 jogCartesian 钳制在 1..3，安全窄化到联合类型
        jogStepLevel.value = (Math.min(3, Math.max(1, Math.trunc(s.stepLevel))) as 1 | 2 | 3)
        jogActiveFlag.value = s.active
      },
    })
    // 5) 双向 watch 接线：3D 内部状态与本组件 ref 双向同步（保持单一数据源）。
    modelLoaded.value = scene3d.modelLoaded.value
    watch(scene3d.modelLoaded, value => { modelLoaded.value = value })
    watch(scene3d.selectedPart, value => {
      // 选中部位时进入聚焦模式（淡出无关 HUD），并立刻刷新连接线几何。
      selectedPart.value = value?.id ?? null
      focusMode.value = !!value
      updateConnector()
    })
    // P0 修复：3D 内部退出聚焦（ESC/dock 视图复位）时同步本地 focusMode，
    // 否则 .focus-mode class 残留导致四边 HUD 一直处于淡出状态
    watch(scene3d.focusMode, value => { focusMode.value = value })
    watch(selectedJoint, updateConnector)
    robot3d = scene3d
    // 底盘反馈 → 3D 模型跟随（升降 mm→滑台行程映射 / 弯腰 deg→rad，见 chassisUnits）。
    // 2026-08-30 第七轮#1：改走 followChassis（拖动中/松手 400ms 内丢弃反馈），
    // 修复"弯腰球拖动时模型被慢速反馈往回拽、球与状态栏数值对不上"
    watch(() => robotStore.chassis.lift?.encoder, v => { if (v !== undefined) scene3d.followChassis?.('lift', v) })
    watch(() => robotStore.chassis.bend?.encoder, v => { if (v !== undefined) scene3d.followChassis?.('bend', v) })
    // 头部反馈 → 3D 模型跟随（2026-08-30）：同底盘改 followHead 抑制窗口，
    // HeadPanel 下发即时预览之外，ROS 反馈到位后收敛（修复点头状态不同步）
    watch(() => robotStore.head.yaw, v => scene3d.followHead?.('yaw', v))
    watch(() => robotStore.head.pitch, v => scene3d.followHead?.('pitch', v))
  }
  // 6) 关节角度趋势采样（500ms 一帧，最多保留 30 个点 ≈ 15 秒窗口）。
  chartTimer = setInterval(() => {
    // 横轴用 HH:MM:SS（zh-CN 24h 取末 5 字符）。
    chartLabels.value.push(new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(-5))
    // 取 J2（肩关节）的当前角度作为曲线代表值（度）。
    chartLeft.value.push(Number(((robotStore.armL.joints[1] ?? 0) * 180 / Math.PI).toFixed(1)))
    chartRight.value.push(Number(((robotStore.armR.joints[1] ?? 0) * 180 / Math.PI).toFixed(1)))
    if (chartLabels.value.length > 30) {
      chartLabels.value.shift(); chartLeft.value.shift(); chartRight.value.shift()
    }
  }, 500)
  // 6) 连接线几何刷新（80ms ≈ 12fps，肉眼看不出抖动且开销小）。
  connectorTimer = setInterval(updateConnector, 80)
  // 7) 异步加载预置点（失败不阻塞 UI）。
  await teach.loadPresets().catch(() => undefined)
})

/**
 * 组件卸载清理：移除全局键盘监听 + 清掉两个周期定时器，避免内存泄漏。
 */
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKey)
  if (chartTimer) clearInterval(chartTimer)
  if (connectorTimer) clearInterval(connectorTimer)
})
</script>

<template>
  <!-- 整个大屏根容器：focus-mode class 由 selectedPart/focusMode 切换，触发四边 HUD 淡出 -->
  <div class="dash" :class="{ 'focus-mode': focusMode }">
    <!-- 3D 视口层（Three.js 渲染）：canvas 由 useRobot3D 内部挂载 -->
    <div ref="viewportRef" class="vp3d"></div>
    <!-- 2D 标签层（DOM 浮于 3D 之上）：选中部位名/键鼠提示等浮层 -->
    <div ref="labelRef" class="vp2d"></div>
    <!-- 3D ↔ 侧栏面板的连接线 SVG：x1/y1 面板、x2/y2 部件屏幕投影 -->
    <svg class="connector" :class="{ visible: connector.visible }">
      <!-- 虚线段：起点面板边缘 → 终点部件锚点 -->
      <line :x1="connector.x1" :y1="connector.y1" :x2="connector.x2" :y2="connector.y2" />
      <!-- 终点圆点：强化锚点视觉 -->
      <circle :cx="connector.x2" :cy="connector.y2" r="3" />
    </svg>

    <!-- HeaderBar：顶部状态条，注入连接状态、各部件故障标志、anyLocked、底盘电机异常数 -->
    <HeaderBar :connected="connected" :backend-mode="backendMode" :robot-name="robotName" :arm-l-fault="robotStore.armL.fault" :arm-r-fault="robotStore.armR.fault"
               :grip-l-fault="robotStore.gripL.fault" :grip-r-fault="robotStore.gripR.fault"
               :any-locked="anyLocked" :wheel-fault-count="wheelFaultCount"
               @stop-arm="side => stopArm(side)" @stop-all="() => callService('/robot/internal/arm/emg_stop', 'robot_core_msgs/ArmEmgStop', {})"
               @reset-all="resetAllArms" @reset-view="reset3dView" @open-help="helpOpen = true" />

    <!-- 操作指南浮层（右上角 ? 帮助 → 全屏键鼠操作手册；2026-08-29 新增） -->
    <HelpGuide v-if="helpOpen" @close="helpOpen = false" />

    <!-- 协作释放常驻浮条（2026-08-29；2026-09-05 A1 改名）：解决"进入 M4 后不知道怎么退出"。
         服务端 mode=4 时显示，Esc/按钮一键退出；交互提示写明键鼠组合用法 + 末端按钮前提 -->
    <div v-if="dragArms.length" class="drag-banner">
      <!-- 琥珀色状态点（与协作释放色系对齐） -->
      <span class="dot"></span>
      <!-- 把 L/R 转成中文左右臂，多臂时用「、」分隔 -->
      <b>{{ dragArms.map(s => s === 'L' ? '左臂' : '右臂').join('、') }} 协作释放(RELEASE)</b>
      <!-- 交互提示：键鼠组合 + 执行前提 + 退出键 -->
      <span class="hint">按住<b>末端按钮</b>才真正拖动、松开即停 · 拖<b>琥珀环</b>=腕端位置跟随 · <b>Shift</b>+拖=空间角度 · <b>Alt</b>+拖=链动微调 · <b>Shift+WASD</b>=2mm步进 · 拖+滚轮=推拉深度 · 双击=前伸 · <b>Esc 退出</b></span>
      <!-- 退出按钮：与 Esc 等效，方便鼠标用户 -->
      <button @click="exitDragMode">退出协作释放 (Esc)</button>
    </div>

    <!-- 键盘微调常显 HUD（2026-08-29）：Shift/Alt+点击关节球选中后，实时提示当前关节与全部键位 -->
    <div v-if="selectedJoint" class="kb-hud">
      <!-- 关节名 + 当前角度（度） -->
      <b>{{ kbName }}</b><span>{{ fmtDeg(kbArm.joints[kbIndex] ?? 0) }}°</span>
      <!-- 全部可用键位（11 项）：步进/快速/精调/切换关节/HOME/取消 -->
      <i>Shift/Alt+拖球微调</i><i>W/S ±0.5°</i><i>Shift+W/S ±3°</i><i>Ctrl+W/S ±0.05°</i>
      <i>Tab/D 下一关节</i><i>A 上一关节</i><i>Q/E 肩</i><i>Space HOME</i><i>Esc 取消</i>
    </div>

    <!-- 键盘笛卡尔 Jog HUD（2026-09-05 任务 TEACH-KEYBOARD-JOG）：
         示教语境（M4 协作释放/示教态）下常驻显示当前步长档位与键位速览；
         按下运动键时高亮 active，提示"按住持续、松开即停"。 -->
    <div v-if="jogShow" class="jog-hud" :class="{ active: jogActiveFlag }">
      <!-- 档位名 + 快捷键切换 -->
      <b>键盘笛卡尔 Jog</b><span class="step">{{ jogStepLabel }}</span>
      <!-- 六轴键位速览 -->
      <i>W/S 进退</i><i>A/D 横移</i><i>R/F 升降</i><i>Q/E 偏航</i><i>Z/X 俯仰</i>
      <i class="step-keys">1 精调 · 2 常规 · 3 大步</i>
      <!-- 按住持续提示（active 时高亮） -->
      <em v-if="jogActiveFlag">运动中 · 松开即停</em>
    </div>

    <!-- 版本水印（右下角项目名 + 版本号）：公开版不展示内部公司名，改为产品名 -->
    <div class="watermark">MARVIN 3D Dashboard · V1.0.0</div>

    <!-- 全局轻量提示（退出拖动/状态变化的可见反馈） -->
    <transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </transition>

    <!-- 四边常显状态 HUD（V1.3.3 方案A：HUD 数据源按视觉方位对调——
         3D 为正面视角，画面左侧是机器人左臂/左爪、右侧是右臂/右爪
         （2026-09-05 实测修正：旧"镜像视角画面左=右臂"与 3D 投影 arm_l→左相反），
         HUD 跟随画面位置（所见即所得），标题保留机器人坐标系名 + 画面方位双标注；
         点击 3D 部位出控制卡片时其余 HUD 淡出（.focus-mode 级联） -->
    <!-- 顶部头部条：选中头部时高亮 -->
    <HeadStrip :head="robotStore.head" :active="selectedPart === 'head'" />
    <!-- 画面左侧 HUD 列：左臂 + 左爪（正面视角下，机器人左臂呈现在观察者左侧；URDF 挂载修正定案） -->
    <aside class="hud-col side-l">
      <ArmStatusPanel title="左臂 ARM_L · 画面左" :arm="robotStore.armL" :active="selectedPart === 'arm_l'" />
      <GripperStatusPanel title="左爪 GRIP_L · 画面左" :grip="robotStore.gripL" :active="selectedPart === 'grip_l'" />
    </aside>
    <!-- 画面右侧 HUD 列：右臂 + 右爪（正面视角下，机器人右臂呈现在观察者右侧） -->
    <aside class="hud-col side-r">
      <ArmStatusPanel title="右臂 ARM_R · 画面右" :arm="robotStore.armR" :active="selectedPart === 'arm_r'" />
      <GripperStatusPanel title="右爪 GRIP_R · 画面右" :grip="robotStore.gripR" :active="selectedPart === 'grip_r'" />
    </aside>

    <main class="body">
      <!-- 中央主区域：上下文卡片 transition（panel 入场/退场动画） -->
      <transition name="panel">
        <!-- contextKey 有值 → 渲染对应子面板；contextPanelRef 取面板矩形 -->
        <div v-if="contextKey" ref="contextPanelRef" class="context-panel">
          <!-- 1) 选中关节 → JointInspector（最优先，因 selectedJoint 优先级高于 selectedPart） -->
          <JointInspector v-if="selectedJoint" :joint-name="selectedJoint" :arm="selectedArm" :busy="busy"
                          @set-joint="setJoint" @zero="(side, index) => setJoint(side, index, 0)"
                          @stop="side => stopArm(side)" @clear="clearArmError" @close="closeContext" />
          <!-- 2) 左臂面板：单臂 + 关节滑条 + 模式切换 -->
          <ArmPanel v-else-if="contextKey === 'arm_l'" side="L" title="左臂 L（画面左侧）" :arm="robotStore.armL"
                    @jog="jogArm" @set-mode="setArmMode" @stop="stopArm" @clear="clearArmError" @home="armHome" />
          <!-- 3) 右臂面板 -->
          <ArmPanel v-else-if="contextKey === 'arm_r'" side="R" title="右臂 R（画面右侧）" :arm="robotStore.armR"
                    @jog="jogArm" @set-mode="setArmMode" @stop="stopArm" @clear="clearArmError" @home="armHome" />
          <!-- 面板标题按机器人爪命名 + 画面方位标注（正面视角下机器人左爪显示在画面左侧、
               右爪在右侧，避免"控制左看右动"误解） -->
          <!-- 4) 左爪面板：拖动本地预览 + 节流下发 + 力/速度预置 -->
          <GripperPanel v-else-if="contextKey === 'grip_l'" title="左爪 L（画面左侧）" :idx="1" :grip="robotStore.gripL"
                        :force-pct="gripUi.L.force" :speed-pct="gripUi.L.speed" :presets="teach.presets.value" :busy="busy"
                        :drag-pct="gripDrag[1].active ? gripDrag[1].preview : null"
                        @position-input="onGripPositionInput" @position-commit="onGripPositionCommit"
                        @set-position="setGripPosition" @set-force="setGripForce" @set-speed="setGripSpeed" @command="gripCommand"
                        @save-preset="name => saveGripperPreset(name, 1)" @load-preset="preset => loadGripperPreset(1, preset)" />
          <!-- 5) 右爪面板 -->
          <GripperPanel v-else-if="contextKey === 'grip_r'" title="右爪 R（画面右侧）" :idx="2" :grip="robotStore.gripR"
                        :force-pct="gripUi.R.force" :speed-pct="gripUi.R.speed" :presets="teach.presets.value" :busy="busy"
                        :drag-pct="gripDrag[2].active ? gripDrag[2].preview : null"
                        @position-input="onGripPositionInput" @position-commit="onGripPositionCommit"
                        @set-position="setGripPosition" @set-force="setGripForce" @set-speed="setGripSpeed" @command="gripCommand"
                        @save-preset="name => saveGripperPreset(name, 2)" @load-preset="preset => loadGripperPreset(2, preset)" />
          <!-- 底盘控制面板（2026-08-29）：行走/转向只读 + 升降 mm / 弯腰 ° 控制 -->
          <ChassisPanel v-else-if="contextKey === 'chassis'" :chassis="robotStore.chassis" :busy="busy"
                        @lift-to="liftTo" @bend-to="bendTo" />
          <!-- 头部控制面板（2026-08-30）：点击 3D 头部弹出，摇头/点头 滑条+执行 -->
          <HeadPanel v-else-if="contextKey === 'head'" :head="robotStore.head" :busy="busy"
                     @yaw-to="headYawTo" @pitch-to="headPitchTo" />
        </div>
      </transition>
        <!-- 底部呼吸式弹窗菜单坞（用户口径：只保留动作与示教入口；2026-08-31 高级功能并入弹窗） -->
      <BottomDock :demo="teach.demoStatus.value" :busy="busy" :teach="teach" :plan="armPlan" :any-locked="anyLocked"
                  @run-action="id => teach.triggerDemo(id)"
                  @select-motion="index => teach.selectedIndex.value = index"
                  @rename-motion="name => teach.renameSelected(name)"
                  @remove-motion="teach.deleteSelected"
                  @replay-motion="replaySelected"
                  @replay-all-motion="replayAllMotion"
                  @reset-view="reset3dView"
                  @stop-all="() => callService('/robot/internal/arm/emg_stop', 'robot_core_msgs/ArmEmgStop', {})"
                  @reset-all="resetAllArms" />
      <!-- 底条底盘 9 电机常显（位于 dock 上方） -->
      <ChassisStrip :chassis="robotStore.chassis" :active="selectedPart === 'chassis' || selectedPart === 'torso'" />
    </main>

  </div>
</template>

<style>
/* ═══════════════════════════════════════════════════════════════════
 * MARVIN 3D Web 示教大屏 — 全局样式
 *
 * 设计系统：
 *   - 深空主题：深黑底 + 青蓝色强调 + 琥珀色警告 + 红色故障
 *   - HUD 风格：无卡片/无边框，纯文字浮于 3D 场景之上
 *   - 自适应字号：clamp() + vw/vh 双向约束，适配 1920+ 大屏到 1280 小屏
 *   - 毛玻璃面板：backdrop-filter:blur + 半透明渐变背景
 * ═══════════════════════════════════════════════════════════════════ */

/* —— 全局重置：清除浏览器默认 margin/padding，统一 border-box 模型 —— */
* { margin:0; padding:0; box-sizing:border-box; }

/* —— CSS 自定义属性（Design Tokens）——
 * 所有颜色/字体/字号在此集中定义，组件通过 var(--xxx) 引用。
 * 修改主题只需改动此处，全站自动跟随。 */
:root {
  /* ═══ 背景色 ═══ */
  --bg:#020610;             /* 主背景：极深蓝黑（#020610），接近纯黑但保留蓝色调 */
  --panel:rgba(5,15,31,.80);/* 面板背景：深蓝 + 80% 不透明度，用于弹窗/卡片 */

  /* ═══ 边框/强调色 ═══ */
  --bd:rgba(46,230,214,.16);/* 边框色：青绿色 16% 透明度，极淡的分割线 */
  --acc:#2ee6d6;            /* 强调色：青绿色（#2EE6D6），全局主色调 */
  --glow:rgba(46,230,214,.25);/* 发光色：青绿色 25% 透明度，text-shadow/box-shadow 用 */
  --hud-tint:rgba(2,8,18,.24);/* HUD 衬底色：极深蓝 24% 透明度，strip/面板超低透明底 */

  /* ═══ 文字色 ═══ */
  --tx:#d8ecff;             /* 主文字色：浅蓝白（#D8ECFF），正文/值显示 */
  --dim:#59809d;            /* 辅助文字色：灰蓝（#59809D），标签/禁用/次要信息 */

  /* ═══ 语义色（状态指示）═══ */
  --grn:#34d399;            /* 成功/正常：绿色（#34D399），已使能/在线/无故障 */
  --amb:#fbbf24;            /* 警告/注意：琥珀色（#FBBF24），运动中/协作释放 */
  --red:#f87171;            /* 故障/急停：红色（#F87171），FAULT/ESTOP/错误码 */

  /* ═══ 字体族 ═══ */
  --f:"Rajdhani","Inter","Segoe UI","Microsoft YaHei",sans-serif;
  /* 正文字体栈：Rajdhani（Google Fonts）> 系统回退，用于 HUD 面板正文 */
  --m:"Share Tech Mono","JetBrains Mono","Cascadia Code",monospace;
  /* 等宽字体栈：Share Tech Mono > 系统等宽，用于数值/角度/代码/状态码 */
  --d:"Orbitron","Rajdhani","Segoe UI",sans-serif;
  /* 3D 标题字体栈：Orbitron（科技感）> 回退，用于面板标题/按钮大字 */

  /* ═══ 自适应字号（2026-08-29 修复文字放大后重叠）═══
   * 口径：大屏（1920+）保持"放大两倍"的观感上限，窗口变小时按 vw/vh 线性收缩，
   * 并用 min() 同时约束宽高两个方向，避免矮窗口下纵向溢出。 */
  --fs-row:clamp(11px, min(1.05vw, 1.75vh), 22px);
  /* 常规键值行/数据行：StatusText 的值、关节角、电机数据等 */
  --fs-title:clamp(12px, min(0.95vw, 1.6vh), 20px);
  /* 面板标题：ArmStatusPanel、GripperStatusPanel 等的 hud-title */
  --fs-cap:clamp(10px, min(0.85vw, 1.45vh), 18px);
  /* 小标题/副标签：底盘条的电机编号、ChassisPanel 的 ctl-head 等 */
  --fs-big:clamp(28px, min(3.1vw, 5.2vh), 64px);
  /* 夹爪大号开度数字：GripperStatusPanel 的 .big-pos .n */
}

/* —— 全局 html/body 容器：满屏、隐藏溢出、深色背景 —— */
html,body,#app {
  width:100vw;              /* 满屏宽度 */
  height:100vh;             /* 满屏高度 */
  overflow:hidden;           /* 禁止滚动（全屏大屏场景） */
  background:var(--bg);      /* 极深蓝黑背景 */
  color:var(--tx);           /* 默认文字色 */
  font-family:var(--f);      /* 默认正文字体 */
}

/* —— 暗角效果：body 伪元素添加四边渐变暗角，增强纵深氛围感 —— */
body::after {
  content:"";               /* 空内容，纯装饰 */
  position:fixed;            /* 固定定位，跟随视口 */
  inset:0;                   /* 四边对齐（等价于 top/right/bottom/left:0） */
  z-index:3;                 /* 在 3D 场景(z-index:1)之上、HUD(z-index:5+)之下 */
  pointer-events:none;       /* 不阻挡鼠标事件 */
  box-shadow:inset 0 0 130px rgba(0,0,0,.48); /* 四边 130px 暗角阴影 */
}

/* ═══ 聚焦模式（.focus-mode）═══
 * 点击 3D 部位后激活：该部位对应的 HUD 保持全亮，其余 HUD 降透明到 .3。
 * 2026-08-30 用户口径："是隐藏不是降透明"→ 但 .12 在深色底上等于消失，
 * 统一提到 .3 保持可读，active 部位由 App.vue 级联恢复全亮。 */
.focus-mode .head-strip, .focus-mode .chassis-strip,
.focus-mode .side-l .hud-block, .focus-mode .side-r .hud-block { opacity:.3; }
.focus-mode .head-strip.active, .focus-mode .chassis-strip.active,
.focus-mode .side-l .hud-block.active, .focus-mode .side-r .hud-block.active { opacity:1; }

/* —— 根容器（.dash）：相对定位的全屏画布，所有子元素绝对定位在其上 —— */
.dash { position:relative; width:100vw; height:100vh; }

/* —— 3D 场景容器（.vp3d）：Three.js Canvas 的挂载点 ——
 * z-index:1 为最底层，CSS 径向渐变提供"深空"背景色，
 * 与 scene.background=null 配合让 Three.js 透明露出 CSS 底色。 */
.vp3d {
  position:absolute; inset:0; z-index:1;
  /* 深空径向渐变底（参考"数字孪生地球"背景）：中心微亮青蓝 #0A2A44 → 边缘沉黑 #020610 */
  background:radial-gradient(ellipse 90% 70% at 50% 40%, #0a2a44 0%, #051527 38%, #020610 74%);
}

/* 底部呼吸坞在聚焦模式下同步淡出，让位 3D 特写 */
.focus-mode .bottom-dock { opacity:.3; transition:opacity .3s; }
.bottom-dock { transition:opacity .3s; }

/* —— Three.js Canvas 保持 block 布局（消除 inline 元素底部间隙）—— */
.vp3d canvas { display:block; }

/* —— CSS2D 标签容器（.vp2d）：3D 空间中的 HTML 标签叠加层 ——
 * z-index:2 在 3D Canvas 之上；pointer-events:none 不阻挡鼠标穿透到 Canvas。 */
.vp2d { position:absolute; inset:0; z-index:2; pointer-events:none; overflow:hidden; }

/* —— 面板→3D 连接线（SVG）：虚线从控制面板右边缘拉到 3D 部位锚点 ——
 * z-index:4 在标签层之上；opacity:0 默认隐藏，.visible 时淡入。 */
.connector {
  position:absolute; inset:0; z-index:4;
  width:100vw; height:100vh;    /* 覆盖全屏 */
  pointer-events:none;           /* 不阻挡鼠标 */
  opacity:0;                     /* 默认隐藏 */
  transition:opacity .2s;        /* 淡入淡出过渡 */
}
.connector.visible { opacity:1; }
/* 虚线：青蓝色 + 虚线动画（stroke-dashoffset 递减产生流动感） */
.connector line {
  stroke:#31b0e6; stroke-width:1.2; stroke-dasharray:7 5;
  filter:drop-shadow(0 0 4px rgba(49,176,230,.7));
  animation:line-flow 1s linear infinite;  /* 1s 完成一轮虚线流动 */
}
/* 连接线终点圆点：白色 + 青色发光 */
.connector circle { fill:#fff; filter:drop-shadow(0 0 6px #31b0e6); }
/* 虚线流动动画：stroke-dashoffset 从 0 到 -12（一个 dash+gap 周期） */
@keyframes line-flow { to { stroke-dashoffset:-12; } }

/* 2026-08-29（HUD 重构）：顶栏布局已全部迁入 HeaderBar.vue——顶部只剩居中 3D 标题，
   MOCK/全景在右上角角标，ROS 状态与急停台沉到右下角悬浮；本文件不再保留顶栏样式。 */
/* 协作释放(RELEASE)常驻浮条：琥珀色高对比，状态来自服务端回显，按钮/Esc 均可退出 */
.drag-banner { position:absolute; z-index:24; top:66px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:10px; padding:6px 14px; border-radius:20px;
  border:1px solid rgba(251,191,36,.45); background:rgba(30,20,3,.88); color:#fbbf24; font-size:11px; font-family:var(--m); pointer-events:auto; box-shadow:0 0 16px rgba(251,191,36,.22); }
.drag-banner .dot { width:8px; height:8px; border-radius:50%; background:#fbbf24; box-shadow:0 0 8px #fbbf24; animation:drag-pulse 1.4s ease-in-out infinite; }
@keyframes drag-pulse { 0%,100% { opacity:.45; } 50% { opacity:1; } }
.drag-banner .hint { color:rgba(251,191,36,.7); font-size:9px; }
.drag-banner button { border:1px solid rgba(251,191,36,.6); background:rgba(251,191,36,.12); color:#fde68a; font-size:10px; padding:3px 10px; border-radius:10px; cursor:pointer; }
.drag-banner button:hover { background:rgba(251,191,36,.25); }
/* 右下角版本水印：贴着急停台（右下约 240px 宽）左侧排布，并避开 status-dock 弹窗 */
.watermark { position:absolute; z-index:15; right:286px; bottom:18px; color:rgba(216,236,255,.42); font-size:10px; font-family:var(--m); letter-spacing:1px; pointer-events:none; text-shadow:0 0 8px rgba(4,12,25,.85); }

/* 控制卡起始高度让位：顶部标题区约高 58px，卡片/面板从 70px 起避开标题（2026-08-29） */
.body { position:absolute; inset:70px 0 0; z-index:10; display:flex; justify-content:flex-start; align-items:flex-start; padding:16px; pointer-events:none; }
/* 四边常显侧栏：侧栏底边抬高到 272px，把底部整条走廊让给底盘信息条（2026-08-29 重排，
   之前 bottom:320px 但内容放大后纵向溢出，爪面板文字直接压到行走/升降电机数据上）。
   宽度改为 clamp 自适应；内容超高时滚动兜底而不是溢出压字。 */
.side-l,.side-r { position:absolute; top:172px; bottom:272px; width:clamp(230px, 15.5vw, 320px);
  z-index:5; display:flex; flex-direction:column; justify-content:flex-start;
  gap:clamp(8px, 1.4vh, 26px); pointer-events:auto; transition:opacity .3s;
  overflow-y:auto; scrollbar-width:none; }
.side-l::-webkit-scrollbar,.side-r::-webkit-scrollbar { display:none; }
.side-l { left:18px; }
.side-r { right:18px; }
/* 聚焦模式整列只禁点击、不做父级降透明（2026-08-30 修复）：opacity 会父子叠加
   （父 .12 × 子 1 = 仍 .12），导致"选中部位对应面板常亮"失效、两侧全部像消失。
   透明度统一由上方 .hud-block 块级规则控制（非选中 .3 / 选中 1）。 */
.focus-mode .side-l,.focus-mode .side-r { pointer-events:none; }
.context-panel { width:420px; pointer-events:auto; }
.side-panel,.joint-inspector,.status-dock { border:1px solid var(--bd); border-radius:10px; background:linear-gradient(145deg,rgba(4,15,31,.90),rgba(2,8,20,.78)); box-shadow:0 22px 54px rgba(0,0,0,.42); backdrop-filter:blur(18px); }
.panel-title { color:var(--acc); font-size:18px; font-weight:650; letter-spacing:2px; margin-bottom:8px; padding-bottom:5px; border-bottom:1px solid rgba(49,176,230,.12); }
.jog-row,.slider-row { display:grid; grid-template-columns:44px 1fr 78px; align-items:center; gap:6px; font-size:18px; color:var(--dim); min-height:32px; }
.jog-row input,.slider-row input { width:100%; accent-color:var(--acc); }
.jn { color:var(--dim); text-align:right; font-family:var(--m); }
.jv { color:#93c5fd; font-family:var(--m); font-size:18px; text-align:right; }
.big-pos { text-align:center; margin:4px 0 9px; }
.big-pos .n { font-size:56px; font-family:var(--m); font-weight:200; background:linear-gradient(180deg,#fff,#31b0e6); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
.big-pos .u { color:var(--acc); font-size:24px; margin-left:2px; }
.button-row,.preset-row { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; margin-top:8px; }
.preset-row { grid-template-columns:1fr 90px; }
.btn,.sbtn { border:1px solid rgba(49,176,230,.28); background:rgba(49,176,230,.08); color:var(--acc); border-radius:5px; font-size:18px; padding:7px 9px; cursor:pointer; transition:.15s; }
.btn:hover,.sbtn:hover { background:rgba(49,176,230,.18); box-shadow:0 0 8px rgba(49,176,230,.18); }
.btn:disabled,.sbtn:disabled { opacity:.4; cursor:not-allowed; }
.btn.primary { background:var(--acc); color:#fff; font-weight:600; }
.btn.danger { border-color:rgba(248,113,113,.45); color:#f87171; background:rgba(248,113,113,.07); }
.full { width:100%; margin-top:8px; }
input,select { background:rgba(3,10,22,.85); border:1px solid rgba(49,176,230,.18); border-radius:4px; color:var(--tx); font-size:18px; padding:5px 6px; outline:none; }

.context-panel :deep(.side-panel) { width:100%; }
.panel-enter-active,.panel-leave-active { transition:.25s cubic-bezier(.18,.9,.22,1.12); }
.panel-enter-from,.panel-leave-to { transform:translateX(-18px); opacity:0; }
.joint-inspector { padding:16px; color:var(--tx); }
.joint-inspector header { display:flex; justify-content:space-between; align-items:flex-start; }
.joint-inspector .title { display:block; font-family:var(--d); font-size:26px; color:#fff; text-shadow:0 1px 0 rgba(46,230,214,.6); }
.joint-inspector .jfunc { font-family:var(--f); font-size:18px; color:var(--acc); margin-left:10px; letter-spacing:1px; }
.joint-inspector .joint-name { display:block; font-family:var(--m); font-size:16px; color:var(--dim); margin-top:3px; }
.joint-inspector .icon { background:none; border:none; color:var(--dim); cursor:pointer; font-size:20px; }
.joint-inspector .readout { font-family:var(--m); font-size:76px; line-height:1; margin:12px 0; color:#fff; text-shadow:0 0 16px rgba(46,230,214,.55); }
.joint-inspector .readout small { color:var(--acc); font-size:30px; }
.joint-inspector .range { display:grid; grid-template-columns:56px 1fr 84px; gap:8px; align-items:center; font-size:18px; color:var(--dim); margin-bottom:11px; }
.joint-inspector .mini-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; margin-bottom:10px; }
.joint-inspector .mini-grid div { padding:6px; border:1px solid rgba(46,230,214,.08); border-radius:4px; text-align:center; }
.joint-inspector .mini-grid .active { border-color:var(--acc); background:rgba(46,230,214,.09); }
.joint-inspector .mini-grid span { display:block; font-size:15px; color:var(--dim); }
.joint-inspector .mini-grid b { font-family:var(--m); font-size:9px; color:#c8fff8; }
.joint-inspector .hint { font-size:8px; color:var(--dim); line-height:1.4; margin-bottom:8px; }
.joint-inspector footer { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; }
.teach-panel { margin-bottom:7px; }
.teach-panel .controls { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
.sample { font-size:10px; color:var(--dim); font-family:var(--m); }
.sample.on { color:var(--grn); text-shadow:0 0 7px rgba(52,211,153,.6); }
.message { margin-top:5px; font-size:9px; color:var(--dim); font-family:var(--m); }
.motion-table { border-top:1px solid rgba(49,176,230,.1); padding-top:6px; }
.table-actions { display:flex; gap:5px; margin-bottom:5px; }
.table-scroll { max-height:128px; overflow:auto; border:1px solid rgba(49,176,230,.08); }
.motion-table table { width:100%; border-collapse:collapse; font-size:9px; font-family:var(--m); }
.motion-table th { position:sticky; top:0; background:#08172d; color:#59809d; padding:4px 5px; text-align:left; white-space:nowrap; }
.motion-table td { padding:3px 5px; color:#c8e5ff; white-space:nowrap; border-top:1px solid rgba(49,176,230,.05); }
.motion-table tr.selected td { background:rgba(49,176,230,.14); }
.motion-table input { border:none; background:transparent; width:78px; padding:0; }
/* I4(2026-09-05)：姿态(四元数)折叠开关与占位——默认收起 4 列，点表头展开 */
.motion-table .quat-toggle { border:none; background:transparent; color:var(--acc); font-size:10px;
  cursor:pointer; padding:0 2px; font-family:var(--m); }
.motion-table .quat-toggle:hover { color:#7ee7ff; text-shadow:0 0 6px rgba(46,230,214,.4); }
.motion-table td.quat-folded { color:#4a6a85; text-align:center; }
.chart-panel { height:186px; background:var(--panel); border:1px solid var(--bd); border-radius:8px; padding:8px; backdrop-filter:blur(12px); }
.chart-panel div { width:100%; height:calc(100% - 16px); }
@keyframes panel-in { from { transform:translateX(-50%) translateY(45px); opacity:0; } to { transform:translateX(-50%) translateY(0); opacity:1; } }

.hud-tag { color:#d8ecff; font-size:9px; font-family:var(--m); padding:2px 6px; border-radius:9px; background:rgba(4,12,25,.68); border:1px solid rgba(49,176,230,.25); text-shadow:0 0 6px rgba(49,176,230,.9); pointer-events:none; white-space:nowrap; }
.hud-tag.arm { color:#a8e0ff; }
.hud-tag.grip { color:#ffd6a8; }
.hud-tag.head,.hud-tag.torso { color:#d9f5ff; }
.hud-tag.chassis { color:#9fb2c4; }

.status-dock { position:absolute; z-index:18; right:16px; bottom:16px; width:240px; padding:8px 10px; pointer-events:auto; }
.status-dock .dock-head { font-family:var(--d); font-size:9px; color:var(--acc); letter-spacing:3px; margin-bottom:4px; }
.status-dock details summary { cursor:pointer; font-size:9px; color:var(--dim); outline:none; }
.status-dock .matrix { margin-top:5px; display:grid; gap:2px; max-height:130px; overflow:auto; }
.status-dock .motor { display:grid; grid-template-columns:80px 1fr 1fr 42px 34px; gap:3px; font-family:var(--m); font-size:8px; color:#9fb2c4; }
.status-dock .motor.err { color:var(--red); }
.joint-hover { font-family:var(--m); font-size:9px; color:#fff; background:rgba(2,10,22,.75); border:1px solid rgba(46,230,214,.45); border-radius:8px; padding:2px 6px; text-shadow:0 0 7px rgba(46,230,214,.9); pointer-events:none; white-space:nowrap; }

/* —— 键盘微调 HUD（2026-08-29）：选中关节后常显，提示当前关节角度与全部键位 —— */
.kb-hud { position:absolute; z-index:23; top:110px; left:50%; transform:translateX(-50%);
  display:flex; align-items:center; gap:9px; padding:6px 16px; border-radius:18px; white-space:nowrap;
  border:1px solid rgba(46,230,214,.35); background:rgba(2,10,22,.8); backdrop-filter:blur(8px);
  color:var(--dim); font-family:var(--m); font-size:10px; pointer-events:none; }
.kb-hud b { color:#fff; font-size:11px; letter-spacing:1px; }
.kb-hud span { color:var(--acc); font-size:13px; }
.kb-hud i { font-style:normal; color:var(--dim); }
.kb-hud i:first-of-type { color:var(--grn); }

/* —— 键盘笛卡尔 Jog HUD（2026-09-05 任务 TEACH-KEYBOARD-JOG）——
   示教语境下常驻，档位/键位速览；active 时强调"运动中、松开即停"。 */
.jog-hud { position:absolute; z-index:23; top:150px; left:50%; transform:translateX(-50%);
  display:flex; align-items:center; gap:8px; padding:6px 14px; border-radius:18px; white-space:nowrap;
  border:1px solid rgba(49,176,230,.4); background:rgba(2,10,22,.8); backdrop-filter:blur(8px);
  color:var(--dim); font-family:var(--m); font-size:10px; pointer-events:none;
  transition:border-color .2s, box-shadow .2s; }
.jog-hud.active { border-color:rgba(46,230,214,.9); box-shadow:0 0 14px rgba(46,230,214,.35); }
.jog-hud b { color:#fff; font-size:11px; letter-spacing:1px; }
.jog-hud .step { color:var(--acc); font-size:11px; font-weight:600; }
.jog-hud i { font-style:normal; color:var(--dim); }
.jog-hud i.step-keys { color:#7ecbff; }
.jog-hud em { font-style:normal; color:var(--grn); font-weight:600; }

/* —— 全局轻量提示浮层（2026-08-29）：退出拖动等状态变化的可见反馈 —— */
.toast { position:absolute; z-index:40; bottom:96px; left:50%; transform:translateX(-50%);
  padding:8px 20px; border-radius:18px; background:rgba(4,20,38,.95); border:1px solid rgba(46,230,214,.5);
  color:#eaffff; font-size:12px; font-family:var(--f); letter-spacing:1px;
  box-shadow:0 6px 24px rgba(0,0,0,.5); pointer-events:none; }
.toast-enter-active, .toast-leave-active { transition:opacity .25s, transform .25s; }
.toast-enter-from, .toast-leave-to { opacity:0; transform:translateX(-50%) translateY(6px); }
</style>
