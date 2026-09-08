/**
 * @file    robot.ts
 * @brief   Web 大屏机器人状态类型定义 + 协议字段中文映射
 * @author Csihan
 * @date    2026-08-28
 *
 * 数据源：/robot/status（std_msgs/String，comms 聚合 JSON）与 /joint_states。
 * 字段与 robot_comms_node 各 onXxxStatus 组装的 JSON 一一对应。
 */

/** 单臂状态（module = arm_L / arm_R） */
export interface ArmStatus {
  mode: number          // -1~4：协议 M0~M4（-1=未知/未设）
  fsm: string           // 状态机：UNINIT/IDLE/ENABLED/MOVING/RECOVERING/FAULT_LOCKED/ESTOP_LOCKED
  joints: number[]      // J1~J7 实际角度（rad，面板显示时转 deg）
  enabled: boolean
  moving: boolean
  fault: boolean
  errorCode: number
  servoErr: number[]    // 7 关节伺服报警码（0=正常）
  estop: boolean        // 软急停锁定（fsm === 'ESTOP_LOCKED'）
  stale: boolean        // 状态不新鲜（后端读取失败）
}

/** 单爪状态（module = gripper_L / gripper_R） */
export interface GripperStatus {
  position: number      // 开度（m）：0=全闭合 0.06=全张开（PGC-300-60 行程 60mm）
  velocity: number      // 速度（m/s）
  effort: number        // 力度（%）；物理力 = effort/100 × 300N（见 utils/gripperUnits）
  gripStatus: number    // 0=运动中 1=到位 2=夹持 3=掉落（PGC 0x0201 原值）
  holding: boolean      // 是否正在夹持物体（grip_status==2 语义别名）
  objectDetected: boolean // 物体检测（传感器原始值）
  moving: boolean
  fault: boolean
  errorCode: number
}

/** 头部状态（module = head_yaw / head_pitch 位置 + head_yaw_motor / head_pitch_motor 电流） */
export interface HeadStatus {
  yaw: number           // 左右角度（deg）
  pitch: number         // 上下角度（deg）
  yawReached: boolean
  pitchReached: boolean
  yawCurrent: number    // 左右电机电流（A）
  pitchCurrent: number  // 上下电机电流（A）
  yawErrorCode: number  // 左右电机错误码（0=正常）
  pitchErrorCode: number
}

/** 底盘单电机明细（module = wheel_1..4 / steer_1..4 / lift_motor / bend_motor）
 *  显示单位口径（用户 2026-08-29 冻结）：速度统一 RPM；行走位置=pulse（编码器脉冲
 *  累计）；转向=°；升降=mm（真机行程 903.3~1453.3 绝对高度）；弯腰=°。
 *  Mock 上报仍为 deg 域仿真值，前端显示层集中换算（见 ChassisStrip/ChassisPanel）。 */
export interface MotorElectric {
  name: string
  enabled: boolean
  moving: boolean
  encoder: number       // 编码器位置：wheel=pulse；steer=deg；lift=mm；bend=deg
  velocity: number      // 仿真域：wheel/steer/bend=deg/s；lift=mm/s（显示层换算 RPM）
  current: number       // 电流 A
  statusCode: number    // 驱动器状态码（0=正常）
  errorCode: number     // 错误码（0=正常）
}

/** 底盘整体：4 行走 + 4 转向 + 升降 + 弯腰（bend_motor，2026-08-29） */
export interface ChassisStatus {
  wheels: MotorElectric[]
  steers: MotorElectric[]
  lift: MotorElectric | null
  bend: MotorElectric | null
}

/** demo_action_exec 的异步回报（协议 V1.0.6，result=0 表示成功）。 */
export interface DemoActionStatus {
  actionId: string
  running: boolean
  result: number | null
  message: string
  elapsedMs: number
}

/** 运动表一行；x/y/z/q... 由 FK 真实填充（P-B 踩点），回放走笛卡尔目标 + j 兜底。 */
export interface TeachPoint {
  name: string
  x: number
  y: number
  z: number
  qw: number
  qx: number
  qy: number
  qz: number
  j: number[]
  dwell_ms?: number                     // 点级停留（覆盖段级，P-B 新增）
}

/** 夹爪预设，字段与 Qt 示教器 gripper_presets.yaml 保持一致。 */
export interface GripperPreset {
  position_pct: number
  force_pct: number
  speed_pct: number
}

// —— SDK 能力补全（2026-08-31 计划 Phase1）：阻抗/力控参数类型 ——

/** 阻抗参数：type=1 关节阻抗 K[7]/D[7]；type=2 笛卡尔阻抗 K[6]/D[6]（对应 ArmSetImpedance.type） */
export interface ImpedanceParams {
  type: 1 | 2                 // 1=关节阻抗 2=笛卡尔阻抗
  k: number[]
  d: number[]
}

/** 力控参数：fc_type + 6 维方向 + PID[7] + 调节上限（对应 SDK OnSetForceCtrPara 与 ArmSetForce） */
export interface ForceParams {
  fc_type: number             // SDK 力控子类型（现场默认 1）
  fx_dir: number[]            // 6 维力控方向 [Fx,Fy,Fz,Tx,Ty,Tz]
  ctrl: number[]              // 关节控制参数 ctrl[7]
  lmt: number                 // 允许调节最大范围（mm，默认 10）
}

/** robot.ini 参数读回执（comms 经 /robot/status module=arm_para 回传） */
export interface ParaReadResult {
  paraName: string
  type: number
  value: number
  sdkRet: number
  ts: number
}

/** 日志下载回执（comms 经 /robot/status module=arm_log 回传；too_large 时 data 为空） */
export interface LogDownloadResult {
  outPath: string
  tooLarge: boolean
  data: string
  ts: number
}

// ══════════ P-B 踩点/动作库类型（2026-08-30 新增，实施计划 docs/archive/implementation_plan_pb_teach.md）══════════

/** tool0 参考系（FACT-GRIPPER-001）：tool0 相对 Link7 rpy=[1.5708,0,0]（URDF 实况 tool0_L/R link） */
export const TOOL0_RPY: [number, number, number] = [1.5708, 0, 0]

/** 段/臂级模式（运动中切换，泄劲防对抗） */
export type ArmModeKind = 'position' | 'impedance'   // 位置 / 笛卡尔阻抗

/** 模式切换事件：从第 at_point 个点起，某臂切换到位姿模式或笛卡尔阻抗 */
export interface ModeEvent {
  at_point: number
  arm: 'L' | 'R'
  mode: ArmModeKind
  params?: { k: number[]; d: number[] }   // impedance 时 K[6]/D[6]
}

/** 动作库 config（配置 A：动作库自带 + 可引用全局默认） */
export interface ActionLibraryConfig {
  speed_pct: number                     // 段级速度档（默认 50）
  acc_pct: number
  timeout_s: number
  blend_ratio: number                   // 点间混合半径（0=直线）
  kd?: { k: number[]; d: number[] }     // 默认阻抗参数（真机实测字段）
  sync_rule?: 'index' | 'time'          // 左右臂回放同步规则
}

/** 单臂动作段（左右独立点集） */
export interface ArmAction {
  side: 'L' | 'R'
  name: string
  config: ActionLibraryConfig
  points: TeachPoint[]
  mode_events: ModeEvent[]
  grip_events?: { at_point: number; action: 'open' | 'close' }[]
  head_events?: { at_point: number; yaw_deg?: number; pitch_deg?: number }[]
  torso_events?: { at_point: number; bend_deg?: number }[]
}

/** 动作库 = 双臂动作 + 元信息（自包含文件） */
export interface ActionLibrary {
  meta: { name: string; version: string; tool_frame: 'tool0'; created_at: string }
  segments: Array<{ id: string; name: string; arms: [ArmAction, ArmAction] }>
  global_defaults: Partial<ActionLibraryConfig>
}

/** 整机聚合状态（useRobotStatus 导出的响应式 store 形状） */
export interface RobotStatusStore {
  armL: ArmStatus
  armR: ArmStatus
  gripL: GripperStatus
  gripR: GripperStatus
  head: HeadStatus
  chassis: ChassisStatus
  demo: DemoActionStatus
  // SDK 能力补全（2026-08-31 计划 Phase2/3）：异步回执（comms 经 /robot/status 回传）
  paraRead: ParaReadResult | null
  logDownload: LogDownloadResult | null
}

// —— 协议中文映射（面板展示用）——
// 2026-09-05（手册 §2.6 审查）：M4 命名统一为「协作释放(RELEASE)」——SDK 手册
// state=4 即协作释放（零力拖动）；此处为协议字段名展示口径，协议数值本身不变。
export const ARM_MODE_NAMES: Record<number, string> = {
  [-1]: '未知', 0: '下使能', 1: '位置', 2: 'PVT', 3: '扭矩', 4: '协作释放(RELEASE)',
}
// 2026-09-05（手册 §2.6）：模式切换存在过渡态，SDK 回显 101~109 表示正在切换；
// 过渡态停留超过 2s 视为切换失败（状态面板据此提示，见 ArmStatusPanel）。
// 过渡态码不进入协议下发，仅做状态映射，故用循环补进同一张表。
for (let i = 101; i <= 109; i++) ARM_MODE_NAMES[i] = '切换中'
export const GRIP_STATUS_NAMES: Record<number, string> = {
  0: '运动中', 1: '到位', 2: '夹持', 3: '掉落',
}
/** 状态机状态名 → 展示文本（急停/故障给红字标记由面板判断） */
export function fsmLabel(fsm: string): string {
  const m: Record<string, string> = {
    UNINIT: '未初始化', IDLE: '空闲', ENABLED: '已使能', MOVING: '运动中',
    RECOVERING: '恢复中', FAULT_LOCKED: '故障锁定', ESTOP_LOCKED: '急停锁定',
  }
  return m[fsm] ?? fsm
}
