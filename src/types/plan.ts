/**
 * @file    plan.ts
 * @brief   Web 全覆盖机械臂控制协议类型定义（协议 V1.0.9，2026-09-03）
 * @author Csihan
 * @date    2026-09-03
 *
 * 对应 comms 新增命令类型（robot_comms_node）：
 *   pln_control / co_pln_control / ik_solve / fk_solve / ft_control / end_tool / sys_control
 * 单位口径（与后端 arm_driver 服务定义一致，避免二次换算）：
 *   - 关节角：rad（Web/ROS 口径）
 *   - 笛卡尔（pln/co_pln）：XYZABC = 位置 mm + ZYX 欧拉角 deg（SDK 口径）
 *   - 运动学（ik/fk）：TCP 位姿 = 位置 m + 四元数
 */

/** 在线规划（pln_control）请求：action 1=关节 2=笛卡尔 3=中断 */
export interface PlanJointReq {
  action: 1
  arm: 1 | 2
  startJoints: number[]      // 起点 7 关节角（rad）
  stopJoints: number[]       // 终点 7 关节角（rad）
  velRatio: number           // 速度比 0~100
  accRatio: number           // 加速度比 0~100
}

export interface PlanCartReq {
  action: 2
  arm: 1 | 2
  startXyzabc: number[]      // 起点 XYZABC（mm + ZYX deg）
  endXyzabc: number[]        // 终点 XYZABC（mm + ZYX deg）
  refJoints: number[]        // 逆解参考角（SDK deg）；全 0=用该臂 home
  velMmS: number             // MOVLA 速度约束 mm/s（0=节点默认）
  accMmS2: number            // MOVLA 加速度约束 mm/s^2（0=节点默认）
  freq: number               // 规划频率 Hz（0=节点默认 50）
}

/** 双臂协同（co_pln_control）请求：action 1=关节协同 2=中断 3=笛卡尔协同 */
export interface CoPlanJointReq {
  action: 1
  startA: number[]; stopA: number[]   // 左臂起止（rad）
  startB: number[]; stopB: number[]   // 右臂起止（rad）
  velRatio: number
  accRatio: number
}

export interface CoPlanCartReq {
  action: 3
  startXyzabcA: number[]; endXyzabcA: number[]   // 左臂起止 XYZABC
  startXyzabcB: number[]; endXyzabcB: number[]   // 右臂起止 XYZABC
  refJointsA: number[]; refJointsB: number[]     // 逆解参考角（SDK deg）
  velMmS: number
  accMmS2: number
  freq: number
}

/** IK 求解响应：joint_angles = 7 关节角（rad） */
export interface IkSolveResult {
  jointAngles: number[]
}

/** FK 正解响应：pose = [x,y,z,qw,qx,qy,qz]（m + 四元数） */
export interface FkSolveResult {
  pose: number[]
}

/** 场力控制（ft_control）请求：FTArmControl 进立场控制参数 */
export interface FtControlReq {
  arm: 1 | 2
  fxDir: number[]            // 六维力方向（位置方向相对基座，姿态方向相对末端）
  k: number                  // 位置方向刚度
  f: number                  // 沿给定方向的力
  freeDis: number            // 位置方向无力区间（mm）
  dis: number                // 沿给定方向的运动距离（mm）
  kn: number                 // 姿态方向刚度
  tn: number                 // 姿态方向扭矩
  nFreeDis: number           // 姿态方向无力区间（度）
  ndis: number               // 姿态方向运动距离（度）
}

/** 末端通信（end_tool）请求：action 1=发送 2=接收 3=清缓存 */
export interface EndToolReq {
  arm: 1 | 2
  action: 1 | 2 | 3
  ch: 1 | 2 | 3              // 1=CANFD 2=COM1 3=COM2
  data: number[]             // 发送字节（≤256，action=1）
}

/** 末端通信接收响应 */
export interface EndToolResp {
  data: number[]             // 接收字节数组
  ch: number
  size: number
}

/** 系统控制（sys_control）请求：action 1=set_time 2=reboot */
export interface SysControlReq {
  action: 1 | 2
  year?: number
  month?: number
  day?: number
  hour?: number
  minute?: number
  second?: number
}

/** 常用 XYZABC 单位换算（与 SDK 口径：mm + ZYX deg） */
export const XYZABC_UNITS = {
  /** m → mm（运动学 pose 转规划 XYZABC 位置段） */
  mToMm: (v: number) => Number((v * 1000).toFixed(2)),
  /** mm → m */
  mmToM: (v: number) => Number((v / 1000).toFixed(4)),
} as const