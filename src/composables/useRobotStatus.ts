/**
 * @file    useRobotStatus.ts
 * @brief   /robot/status 统一订阅与解析分发（Web 大屏四边面板唯一数据源）
 * @author Csihan
 * @date    2026-08-28
 *
 * 设计：
 *   - comms 节点把所有内部状态聚合为 /robot/status（std_msgs/String JSON），
 *     每条 {type:'status_report', source, module, content:{...}}；
 *   - parseStatusMessage 为纯函数：一条消息 + store → 就地更新对应数据域，
 *     便于单元测试（不依赖 rosbridge）；
 *   - rosbridge 订阅在 start() 里建立；组件直接消费响应式 store 字段。
 */
import { reactive, ref } from 'vue'
import type {
  ArmStatus, GripperStatus, MotorElectric, RobotStatusStore,
} from '../types/robot'

/** 后端模式（V1.4.6）：get_version 运行时探测——mock=仿真后端 / real=真机后端 / unknown=未探测。
 *  右上角徽标与连接信息卡据此动态显示：mock 后端固定回 robot_name=mock-marvin，
 *  真机返回控制器固件名，据此判定可避免真机联调时误挂"MOCK"安全徽标误导操作者。 */
export const backendMode = ref<'unknown' | 'mock' | 'real'>('unknown')
/** 探测到的机器人名称（mock-marvin / 真机固件名），仅连接信息卡展示用。 */
export const robotName = ref('')

/** 默认值工厂：未知状态先给"安全默认"，首条消息到达后覆盖 */
function defaultStore(): RobotStatusStore {
  const arm = (): ArmStatus => ({
    mode: -1, fsm: 'UNINIT', joints: new Array(7).fill(0),
    enabled: false, moving: false, fault: false, errorCode: 0,
    servoErr: new Array(7).fill(0), estop: false, stale: false,
  })
  const grip = (): GripperStatus => ({
    position: 0, velocity: 0, effort: 0, gripStatus: 1,
    holding: false, objectDetected: false,
    moving: false, fault: false, errorCode: 0,
  })
  const motor = (name: string): MotorElectric => ({
    name, enabled: false, moving: false, encoder: 0,
    velocity: 0, current: 0, statusCode: 0, errorCode: 0,
  })
  return {
    armL: arm(), armR: arm(),
    gripL: grip(), gripR: grip(),
    head: { yaw: 0, pitch: 0, yawReached: true, pitchReached: true,
            yawCurrent: 0, pitchCurrent: 0, yawErrorCode: 0, pitchErrorCode: 0 },
    chassis: {
      wheels: [1, 2, 3, 4].map(i => motor(`wheel_${i}`)),
      steers: [1, 2, 3, 4].map(i => motor(`steer_${i}`)),
      lift: motor('lift_motor'),
      bend: motor('bend_motor'),   // 弯腰电机明细（2026-08-29，motor_driver 新上报）
    },
    demo: { actionId: '', running: false, result: null, message: '', elapsedMs: 0 },
    // SDK 能力补全（2026-08-31）：参数读 / 日志下载 回执初始为 null
    paraRead: null,
    logDownload: null,
  }
}

/** 全局单例 store（多个面板共享同一份数据） */
export const robotStore = reactive<RobotStatusStore>(defaultStore())

/**
 * 解析一条 /robot/status 消息并就地更新 store。
 * @param d    JSON.parse 后的消息对象（含 module 与 data/content）
 * @param store 目标 store（默认全局单例，测试可传入临时 store）
 * @note  comms 的 makeReport 结构：{content:{module, data}}（老格式）与
 *        {module, data}（直接平铺）都兼容，取值顺序 content → 顶层。
 */
export function parseStatusMessage(
    d: any, store: RobotStatusStore = robotStore): void {
  const c = d?.content ?? d ?? {}
  // demo_action_report 不走 status_report 包裹，Comms 将执行器 JSON 原样发布。
  if (d?.type === 'demo_action_report' || c?.type === 'demo_action_report') {
    const data = d?.content ?? c?.content ?? c ?? {}
    store.demo.actionId = data.action_id ?? ''
    store.demo.running = false
    store.demo.result = typeof data.result === 'number' ? data.result : null
    store.demo.message = data.message ?? ''
    store.demo.elapsedMs = data.elapsed_ms ?? 0
    return
  }
  const mod: string = c.module ?? ''
  const data = c.data ?? c.content ?? {}

  // —— 双臂：模式/状态机/急停/错误 + J1~J7 实际角（rad）——
  if (mod === 'arm_L' || mod === 'arm_R') {
    const arm = mod === 'arm_L' ? store.armL : store.armR
    if (data.mode !== undefined) arm.mode = data.mode
    if (data.fsm_state) {
      arm.fsm = data.fsm_state
      arm.estop = data.fsm_state === 'ESTOP_LOCKED'   // 软急停判定
    }
    if (data.joint_position) arm.joints = data.joint_position.slice(0, 7)
    arm.enabled = !!data.enabled
    arm.moving = !!data.moving
    arm.fault = !!data.fault
    arm.errorCode = data.error_code ?? 0
    if (data.servo_err) arm.servoErr = data.servo_err.slice(0, 7)
    arm.stale = !!data.stale
    return
  }

  // —— 双爪：位置/速度/力度/夹持状态/故障 ——
  if (mod === 'gripper_L' || mod === 'gripper_R') {
    const g = mod === 'gripper_L' ? store.gripL : store.gripR
    g.position = data.position ?? g.position
    g.velocity = data.velocity ?? g.velocity
    g.effort = data.effort ?? g.effort
    g.gripStatus = data.grip_status ?? g.gripStatus
    g.holding = !!data.holding
    g.objectDetected = !!data.object_detected
    g.moving = !!data.moving
    g.fault = !!data.fault
    g.errorCode = data.error_code ?? 0
    return
  }

  // —— 头部：左右(head_yaw) / 上下(head_pitch)，deg ——
  if (mod === 'head_yaw' || mod === 'head_pitch') {
    const deg = data.position ?? 0
    if (mod === 'head_yaw') {
      store.head.yaw = deg
      store.head.yawReached = !!data.reached
    } else {
      store.head.pitch = deg
      store.head.pitchReached = !!data.reached
    }
    return
  }

  // —— 头部电机电流明细（head_yaw_motor / head_pitch_motor，2026-08-29）——
  if (mod === 'head_yaw_motor' || mod === 'head_pitch_motor') {
    const isYaw = mod === 'head_yaw_motor'
    const cur = data.current ?? 0
    const err = data.error_code ?? 0
    if (isYaw) { store.head.yawCurrent = cur; store.head.yawErrorCode = err }
    else { store.head.pitchCurrent = cur; store.head.pitchErrorCode = err }
    return
  }

  // —— 底盘电机明细：wheel_1..4 / steer_1..4 / lift_motor / bend_motor ——
  // 弯腰电机（bend_motor，2026-08-29）：motor_driver 跟随 torso 模块上报的明细，
  // 数据域与行走/转向一致（encoder=deg、velocity=deg/s），显示层换算单位
  const wheelIdx = /^wheel_([1-4])$/.exec(mod)
  const steerIdx = /^steer_([1-4])$/.exec(mod)
  const fill = (m: MotorElectric) => {
    m.encoder = data.encoder ?? 0
    m.velocity = data.velocity ?? 0
    m.current = data.current ?? 0
    m.enabled = !!data.enabled
    m.moving = !!data.moving
    m.statusCode = data.status_code ?? 0
    m.errorCode = data.error_code ?? 0
  }
  if (wheelIdx) { fill(store.chassis.wheels[Number(wheelIdx[1]) - 1]); return }
  if (steerIdx) { fill(store.chassis.steers[Number(steerIdx[1]) - 1]); return }
  if (mod === 'lift_motor' && store.chassis.lift) { fill(store.chassis.lift); return }
  if (mod === 'bend_motor' && store.chassis.bend) { fill(store.chassis.bend); return }

  // —— SDK 能力补全（2026-08-31 计划 Phase2/3）：参数读 / 日志下载回执 ——
  if (mod === 'arm_para') {
    store.paraRead = {
      paraName: data.para_name ?? '',
      type: data.type ?? 1,
      value: data.value ?? 0,
      sdkRet: data.sdk_ret ?? 0,
      ts: Date.now(),
    }
    return
  }
  if (mod === 'arm_log') {
    store.logDownload = {
      outPath: data.out_path ?? '',
      tooLarge: !!data.too_large,
      data: data.data ?? '',
      ts: Date.now(),
    }
    return
  }
}

/**
 * 建立 rosbridge 订阅（App 挂载时调用一次）。
 * @param subscribe useRos 提供的订阅函数（依赖注入避免循环引用）
 */
export function startStatusSubscription(
    subscribe: (topic: string, type: string, cb: (msg: any) => void) => unknown): void {
  subscribe('/robot/status', 'std_msgs/String', (msg: any) => {
    try {
      const parsed = JSON.parse(msg.data)
      parseStatusMessage(parsed)
    } catch (_) {
      // 非法 JSON 直接忽略：状态流是周期性的，丢弃一条不影响后续
    }
  })
}
