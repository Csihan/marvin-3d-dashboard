/**
 * @file    chassisUnits.ts
 * @brief   底盘电机显示单位换算（用户口径 2026-08-29 冻结）
 * @author Csihan
 * @date    2026-08-29
 *
 * 口径：
 *   - 速度统一 RPM。Mock 上报为仿真域数值（wheel/steer/bend=deg/s、lift=mm/s），
 *     ÷6 折算成"每分钟量"统一展示；真机驱动层直报电机轴 RPM 后删除换算。
 *   - 位置：行走=pulse（Mock 以 deg 域积分值代替脉冲计数显示，真机驱动直报
 *     pulse 后显示层无需改动）；转向=°；升降=mm（绝对高度 903.3~1453.3，
 *     来源 ProtocolParser.cpp 行程注释）；弯腰=°。
 */

/** 升降电机行程（绝对高度 mm）：与协议解析层注释一致（0.9033~1.4533m） */
export const LIFT_MIN_MM = 903.3
export const LIFT_MAX_MM = 1453.3

/** 弯腰关节限位（°）：URDF torso_pitch_joint ±1.5708rad（示例模型同口径） */
export const BEND_MIN_DEG = -90
export const BEND_MAX_DEG = 90

/** 仿真域速度 → RPM 显示值（deg/s 或 mm/s ÷ 6 ≈ 每分钟口径，见文件头） */
export function toRpm(velSim: number): number { return velSim / 6 }

/** 行走电机位置显示：Mock deg 累计值原样作为 pulse 计数（真机直报 pulse） */
export function toWheelPulse(encoderDeg: number): number { return Math.round(encoderDeg) }

/** 升降 mm（绝对高度）→ URDF torso_lift_joint 滑台行程 m（0~0.55 线性映射），
 *  供 3D 模型驱动；903.3mm=滑台 0（最低），1453.3mm=0.55m（最高）。 */
export function liftMmToUrdf(mm: number): number {
  const t = (mm - LIFT_MIN_MM) / (LIFT_MAX_MM - LIFT_MIN_MM)
  return Math.min(Math.max(t, 0), 1) * 0.55
}

/** URDF 滑台行程 m → 升降绝对高度 mm（3D 拖动反推目标值用） */
export function urdfToLiftMm(m: number): number {
  const t = Math.min(Math.max(m / 0.55, 0), 1)
  return LIFT_MIN_MM + t * (LIFT_MAX_MM - LIFT_MIN_MM)
}
