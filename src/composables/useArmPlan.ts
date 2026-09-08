/**
 * @file    useArmPlan.ts
 * @brief   Web 全覆盖机械臂控制命令封装（协议 V1.0.9，2026-09-03）
 * @author Csihan
 * @date    2026-09-03
 *
 * 与 useTeach 平级的独立 composable：只做「协议组装 + 结果解析」，不依赖任何面板。
 * 对应 comms 新增命令类型（robot_comms_node 协议 V1.0.9）：
 *   pln_control / co_pln_control / ik_solve / fk_solve / ft_control / end_tool / sys_control
 *
 * 响应机制（与 useTeach.getToolParams 同款）：
 *   - send() 走 human_extern_cmd 服务，返回的 res.ret 只是"协议层是否接受"；
 *   - 带 data 的结果（ik_solve 关节角 / fk_solve 位姿 / end_tool 接收字节）经
 *     /robot/status（header.type 匹配）异步回传，用 waitForProtocolResponse 捕获。
 *
 * 单位口径（与后端服务定义一致，避免二次换算）：
 *   - 关节角：rad（Web/ROS 口径）
 *   - 笛卡尔（pln/co_pln）：XYZABC = 位置 mm + ZYX 欧拉角 deg（SDK 口径）
 *   - 运动学（ik/fk）：TCP 位姿 = 位置 m + 四元数
 */
import { ref } from 'vue'
import type {
  CoPlanCartReq, CoPlanJointReq, EndToolReq, EndToolResp,
  FtControlReq, PlanCartReq, PlanJointReq,
} from '../types/plan'

/** ROS 命令发送函数（来自 useCommandBus.sendCommand，服务请求-响应） */
type RosSender = (type: string, content: any) => Promise<any>
/** ROS 话题订阅函数（来自 useRos.subscribe） */
type RosSubscriber = (topic: string, msgType: string, cb: (msg: any) => void) => unknown

/** 协议响应统一在 content.ret 中（与 useTeach.rosOk 同口径） */
function rosOk(res: any): boolean {
  return res?.content?.ret !== false && res?.ret !== false
}

/** 臂枚举 → 协议 arm 号（arm_L=1 / arm_R=2） */
export const armToId = (side: 'arm_L' | 'arm_R'): 1 | 2 => (side === 'arm_L' ? 1 : 2)

export function useArmPlan(send: RosSender, subscribe?: RosSubscriber) {
  const message = ref('')
  const lastError = ref('')

  /**
   * 等待 /robot/status 上 header.type 匹配的协议响应（一次性，取到即退订）。
   * @param wantType 命令类型（pln_control / ik_solve / fk_solve / end_tool 等）
   * @param timeoutMs 超时（默认 4s）
   * @returns 响应 content 对象；超时/未注入 subscribe 返回 null
   */
  function waitForProtocolResponse(wantType: string, timeoutMs = 4000): Promise<any | null> {
    if (!subscribe) return Promise.resolve(null)
    return new Promise((resolve) => {
      let settled = false
      let handle: unknown = null
      const finish = (v: any) => {
        if (settled) return
        settled = true
        try { (handle as { unsubscribe?: () => void } | null)?.unsubscribe?.() } catch (_) { /* 清理失败可忽略 */ }
        resolve(v)
      }
      handle = subscribe('/robot/status', 'std_msgs/String', (msg: any) => {
        try {
          const raw = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)
          const data = JSON.parse(raw)
          if (data?.header?.type === wantType) finish(data?.content ?? null)
        } catch (_) { /* 单条非法消息直接忽略 */ }
      })
      setTimeout(() => finish(null), timeoutMs)
    })
  }

  /** 通用发送包装：send → ret 检查 → message/lastError 记录 */
  async function sendOk(type: string, content: any): Promise<boolean> {
    const res = await send(type, content)
    const ok = rosOk(res)
    if (!ok) lastError.value = `${type} 失败：${res?.values ?? res?.message ?? '协议返回 false'}`
    else message.value = `${type} 已受理`
    return ok
  }

  // ──────────────────────────────────────────────────────────────
  // 在线规划（pln_control）
  // ──────────────────────────────────────────────────────────────

  /** 关节角直发（位置跟随模式）：IK 求解结果应用 / 单点直达用 */
  async function goJoints(arm: 1 | 2, jointAngles: number[]): Promise<boolean> {
    return sendOk('manipulators_control', {
      arm, control_mode: 1,
      joint_angles: jointAngles, velocity_pct: 10, acceleration_pct: 10,
    })
  }

  /** 关节空间规划（action=1）：从当前点到目标关节角（平滑轨迹） */
  async function plnJoint(req: PlanJointReq): Promise<boolean> {
    return sendOk('pln_control', {
      arm: req.arm, action: 1,
      start_joints: req.startJoints, stop_joints: req.stopJoints,
      vel_ratio: req.velRatio, acc_ratio: req.accRatio,
    })
  }

  /** 笛卡尔直线规划（action=2）：起止 XYZABC（mm+deg），内部 IK 反解插补 */
  async function plnCart(req: PlanCartReq): Promise<boolean> {
    return sendOk('pln_control', {
      arm: req.arm, action: 2,
      start_xyzabc: req.startXyzabc, end_xyzabc: req.endXyzabc,
      ref_joints: req.refJoints,
      vel_mm_s: req.velMmS, acc_mm_s2: req.accMmS2, freq: req.freq,
    })
  }

  /** 中断规划运动（action=3） */
  async function plnStop(arm: 1 | 2): Promise<boolean> {
    return sendOk('pln_control', { arm, action: 3 })
  }

  // ──────────────────────────────────────────────────────────────
  // 双臂协同规划（co_pln_control）
  // ──────────────────────────────────────────────────────────────

  /** 关节空间协同（action=1）：两臂同时开始（不一定同时结束） */
  async function coPlnJoint(req: CoPlanJointReq): Promise<boolean> {
    return sendOk('co_pln_control', {
      action: 1,
      start_a: req.startA, stop_a: req.stopA,
      start_b: req.startB, stop_b: req.stopB,
      vel_ratio: req.velRatio, acc_ratio: req.accRatio,
    })
  }

  /** 笛卡尔协同（action=3）：两臂沿直线同步运动（MOVLA 生成点集同时下发） */
  async function coPlnCart(req: CoPlanCartReq): Promise<boolean> {
    return sendOk('co_pln_control', {
      action: 3,
      start_xyzabc_a: req.startXyzabcA, end_xyzabc_a: req.endXyzabcA,
      start_xyzabc_b: req.startXyzabcB, end_xyzabc_b: req.endXyzabcB,
      ref_joints_a: req.refJointsA, ref_joints_b: req.refJointsB,
      vel_mm_s: req.velMmS, acc_mm_s2: req.accMmS2, freq: req.freq,
    })
  }

  /** 中断协同规划（action=2）：两臂同时打断 */
  async function coPlnStop(): Promise<boolean> {
    return sendOk('co_pln_control', { action: 2 })
  }

  // ──────────────────────────────────────────────────────────────
  // 运动学（ik_solve / fk_solve）
  // ──────────────────────────────────────────────────────────────

  /**
   * IK 求解：TCP 位姿（m + 四元数）→ 7 关节角（rad）。
   * 结果经 /robot/status（type=ik_solve）异步回传，data.joint_angles 为关节角数组。
   * @returns 关节角数组（rad）；失败返回 null（lastError 已置原因）
   */
  async function ikSolve(arm: 1 | 2, pose: { x: number; y: number; z: number; qw: number; qx: number; qy: number; qz: number }): Promise<number[] | null> {
    const pending = waitForProtocolResponse('ik_solve')
    const res = await send('ik_solve', {
      arm,
      pose: {
        position: { x: pose.x, y: pose.y, z: pose.z },
        quaternion: { w: pose.qw, x: pose.qx, y: pose.qy, z: pose.qz },
      },
    })
    if (!rosOk(res)) {
      lastError.value = `IK 求解失败：${res?.values ?? res?.message ?? '协议返回 false'}`
      return null
    }
    const content = await pending
    const d = content?.data ?? {}
    const ja = Array.isArray(d.joint_angles) ? d.joint_angles.map(Number) : []
    if (ja.length !== 7) {
      lastError.value = `IK 求解失败：${content?.message ?? '响应超时或缺 joint_angles'}`
      return null
    }
    message.value = `IK 求解成功：${content?.message ?? '7 关节角已返回'}`
    return ja
  }

  /**
   * FK 正解：7 关节角（rad）→ TCP 位姿（m + 四元数）。
   * 结果经 /robot/status（type=fk_solve）异步回传，data.pose = [x,y,z,qw,qx,qy,qz]。
   * @returns 位姿数组 [x,y,z,qw,qx,qy,qz]；失败返回 null
   */
  async function fkSolve(arm: 1 | 2, jointAngles: number[]): Promise<number[] | null> {
    const pending = waitForProtocolResponse('fk_solve')
    const res = await send('fk_solve', { arm, joint_angles: jointAngles })
    if (!rosOk(res)) {
      lastError.value = `FK 求解失败：${res?.values ?? res?.message ?? '协议返回 false'}`
      return null
    }
    const content = await pending
    const d = content?.data ?? {}
    const ps = Array.isArray(d.pose) ? d.pose.map(Number) : []
    if (ps.length !== 7) {
      lastError.value = `FK 求解失败：${content?.message ?? '响应超时或缺 pose'}`
      return null
    }
    message.value = `FK 求解成功：${content?.message ?? 'TCP 位姿已返回'}`
    return ps
  }

  // ──────────────────────────────────────────────────────────────
  // 场力控制（ft_control）
  // ──────────────────────────────────────────────────────────────

  /** 场力控制：末端以给定力/扭矩运动到指定位置/姿态距离 */
  async function ftControl(req: FtControlReq): Promise<boolean> {
    return sendOk('ft_control', {
      arm: req.arm,
      fx_dir: req.fxDir,
      k: req.k, f: req.f, free_dis: req.freeDis, dis: req.dis,
      kn: req.kn, tn: req.tn, n_free_dis: req.nFreeDis, ndis: req.ndis,
    })
  }

  // ──────────────────────────────────────────────────────────────
  // 末端通信（end_tool）
  // ──────────────────────────────────────────────────────────────

  /** 发送数据到末端（action=1）：data 字节数组 ≤256 */
  async function endToolSend(req: EndToolReq): Promise<boolean> {
    return sendOk('end_tool', {
      arm: req.arm, action: 1, ch: req.ch,
      data: req.data, data_size: req.data.length,
    })
  }

  /**
   * 接收末端数据（action=2）：返回接收字节数组 + 通道 + 长度。
   * 结果经 /robot/status（type=end_tool）异步回传。
   */
  async function endToolRecv(arm: 1 | 2, ch: 1 | 2 | 3): Promise<EndToolResp | null> {
    const pending = waitForProtocolResponse('end_tool')
    const res = await send('end_tool', { arm, action: 2, ch })
    if (!rosOk(res)) {
      lastError.value = `末端接收失败：${res?.values ?? res?.message ?? '协议返回 false'}`
      return null
    }
    const content = await pending
    const d = content?.data ?? {}
    const arr = Array.isArray(d.data) ? d.data.map(Number) : []
    if (!arr.length && d.size !== 0) {
      lastError.value = `末端接收失败：${content?.message ?? '响应超时或缺 data'}`
      return null
    }
    message.value = `末端接收成功：${arr.length} 字节（ch=${d.ch ?? ch}）`
    return { data: arr, ch: d.ch ?? ch, size: d.size ?? arr.length }
  }

  /** 清末端缓存（action=3） */
  async function endToolClear(arm: 1 | 2, ch: 1 | 2 | 3): Promise<boolean> {
    return sendOk('end_tool', { arm, action: 3, ch })
  }

  // ──────────────────────────────────────────────────────────────
  // 系统控制（sys_control）
  // ──────────────────────────────────────────────────────────────

  /** 设置控制器系统时间（action=1） */
  async function sysSetTime(t: { year: number; month: number; day: number; hour: number; minute: number; second: number }): Promise<boolean> {
    return sendOk('sys_control', { action: 1, ...t })
  }

  /** 软重启控制板（action=2，会中断控制） */
  async function sysReboot(): Promise<boolean> {
    return sendOk('sys_control', { action: 2 })
  }

  return {
    message, lastError,
    goJoints,
    plnJoint, plnCart, plnStop,
    coPlnJoint, coPlnCart, coPlnStop,
    ikSolve, fkSolve,
    ftControl,
    endToolSend, endToolRecv, endToolClear,
    sysSetTime, sysReboot,
  }
}

export type ArmPlanController = ReturnType<typeof useArmPlan>