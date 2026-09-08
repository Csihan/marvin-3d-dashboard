/**
 * @file    ik.ts
 * @brief   场景 IK 求解模块：基于 URDF 场景图的数值阻尼最小二乘 IK（3D 位置 / 6D 位姿）
 * @author Csihan
 * @date    2026-09-01
 *
 * 设计（P3 交互拆分，2026-09-01）：
 *   - 从 useRobot3D.ts 剥离 solveArmIK / solveArmIK6D / computeTool0 / solveTool0IK6D /
 *     clampJointValue，收敛为独立模块；依赖注入「URDF 模型对象」（robot 场景图）——
 *     IK 用前向差分以场景图 FK 为真值，无独立运动学模型；
 *   - 数学核心（solve3x3/solveLinear/quatToRotVec/dlsStep）复用 utils/robotMath（P1）；
 *   - 行为「原样迁移」（阻尼 λ²、步幅钳制、收敛阈、雅可比差分均不改），
 *     保证踩点回放与拖动手感与重构前一致。
 */

import * as THREE from 'three'
import { solve3x3, solveLinear, quatToRotVec } from '../utils/robotMath'
import { shouldInvert } from './jointCalibration'

/** 双臂 7 关节基名（与协议/URDF 关节名 Joint1~7_L/R 对应）。 */
const ARM_JOINTS = ['Joint1', 'Joint2', 'Joint3', 'Joint4', 'Joint5', 'Joint6', 'Joint7'] as const

/**
 * 关节角钳制到 URDF 限位（urdf-loader 的限位字段是 joint.limit，此前误写 .limits
 * 导致永不钳制——P0 修复）。限位缺失/非法时返回原值。
 * @param jointName  URDF 关节名（含 _L/_R 后缀）
 * @param value      目标角度（rad）
 * @param robot      URDF 模型对象（joints 表）
 */
export function clampJointValue(jointName: string, value: number, robot: any): number {
  const limit = robot?.joints?.[jointName]?.limit
  if (!limit || Number.isNaN(Number(limit.lower)) || Number.isNaN(Number(limit.upper))) return value
  return THREE.MathUtils.clamp(value, Number(limit.lower), Number(limit.upper))
}

/**
 * FK 正解：取 tool0 link（URDF `tool0_L/R`，模型域）的世界位姿。
 * 用于踩点（记录 xyz+quat）与回放目标校验。返回 null 表示模型未就绪。
 */
export function computeTool0(
  side: 'L' | 'R',
  robot: any,
): { pos: THREE.Vector3; quat: THREE.Quaternion } | null {
  const link = robot?.getObjectByName?.(`tool0_${side}`)
  if (!link) return null
  return {
    pos: link.getWorldPosition(new THREE.Vector3()),
    quat: link.getWorldQuaternion(new THREE.Quaternion()),
  }
}

/**
 * 数值 IK（阻尼最小二乘，仅位置）：目标 = 手柄锚点世界位置，姿态不约束（拖动只关心点位）。
 * 雅可比用前向差分（直接以场景图 FK 为真值，无需独立运动学模型）；
 * 每迭代步幅钳制 ±0.05rad，配合关节限位钳制，保证收敛过程不超限不跳变。
 * @param side      臂侧 'L' | 'R'
 * @param targetWorld IK 目标世界位置（即被拖动的点）
 * @param angles    当前 7 关节角（rad），就地迭代更新
 * @param robot     URDF 模型对象（setJointValues 写关节）
 * @param handle    IK 跟随锚点对象（其世界位置即被拖动的点）
 * @param mask      参与解算关节序号集；null=全部 7 关节
 */
export function solveArmIK(
  side: 'L' | 'R',
  targetWorld: THREE.Vector3,
  angles: number[],
  robot: any,
  handle: THREE.Object3D,
  mask: number[] | null,
): number[] {
  if (!robot || !handle) return angles
  const names = ARM_JOINTS.map(n => `${n}_${side}`)
  // ★ 2026-09-03 模型侧方向校准：IK 迭代中的 setJointValues 也需对模型取反
  const apply = (vals: number[]) =>
    robot.setJointValues(Object.fromEntries(names.map((n, i) => {
      const baseName = ARM_JOINTS[i]
      return [n, shouldInvert(side, baseName) ? -vals[i] : vals[i]]
    })))
  const anchor = () => handle.getWorldPosition(new THREE.Vector3())
  const lam2 = 0.0025                       // DLS 阻尼 λ²=(0.05)²：奇异位形附近防数值爆炸
  const active = mask ?? [0, 1, 2, 3, 4, 5, 6]
  for (let iter = 0; iter < 8; iter++) {
    apply(angles)
    const p = anchor()
    const err = targetWorld.clone().sub(p)
    // 收敛阈 0.5mm（2026-08-31 从 2.5mm 下调）：此前 2.5mm 阈值把键盘步进 2mm/次的
    // 单步直接吞掉（err<阈 → 0 迭代 → 模型不动），说明书写 Shift+WASD=2mm 步进却无反应。
    if (err.length() < 0.0005) break
    const J: number[][] = [[0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0]]
    for (const j of active) {
      const h = 0.01
      const pert = [...angles]
      pert[j] += h
      apply(pert)
      const p2 = anchor()
      J[0][j] = (p2.x - p.x) / h
      J[1][j] = (p2.y - p.y) / h
      J[2][j] = (p2.z - p.z) / h
    }
    // A = JJᵀ + λ²I（3x3），y = A⁻¹e，dθ = Jᵀy
    const A: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        let dot = 0
        for (let j = 0; j < 7; j++) dot += J[r][j] * J[c][j]
        A[r][c] = dot + (r === c ? lam2 : 0)
      }
    }
    const y = solve3x3(A, [err.x, err.y, err.z])
    for (const j of active) {
      let dth = J[0][j] * y[0] + J[1][j] * y[1] + J[2][j] * y[2]
      dth = THREE.MathUtils.clamp(dth, -0.05, 0.05)
      angles[j] = clampJointValue(names[j], angles[j] + dth, robot)
    }
  }
  apply(angles)
  return angles
}

/**
 * 6D 数值 IK（阻尼最小二乘）：目标 = tool0 世界位姿（位置 + 姿态）。
 * 在 solveArmIK（仅位置）基础上扩展：误差从 3 维扩到 6 维（位置误差 +
 * 姿态旋转矢量误差），雅可比姿态行用 tool0 旋转矩阵前向差分，保证
 * 踩点回放时不仅"末端点到位"而且"姿态对齐"（仿人手臂方向自然）。
 * @param handle IK 跟随锚点对象（其世界位姿即 tool0）
 * @param mask 参与解算关节序号集（null=全部 7 关节）
 */
export function solveArmIK6D(
  side: 'L' | 'R',
  targetPos: THREE.Vector3,
  targetQuat: THREE.Quaternion,
  angles: number[],
  robot: any,
  handle: THREE.Object3D,
  mask: number[] | null,
): number[] {
  if (!robot || !handle) return angles
  const names = ARM_JOINTS.map(n => `${n}_${side}`)
  // ★ 2026-09-03 模型侧方向校准：IK 迭代中的 setJointValues 也需对模型取反
  const apply = (vals: number[]) =>
    robot.setJointValues(Object.fromEntries(names.map((n, i) => {
      const baseName = ARM_JOINTS[i]
      return [n, shouldInvert(side, baseName) ? -vals[i] : vals[i]]
    })))
  const anchorPos = () => handle.getWorldPosition(new THREE.Vector3())
  const anchorQuat = () => handle.getWorldQuaternion(new THREE.Quaternion())
  const lam2 = 0.0025
  const active = mask ?? [0, 1, 2, 3, 4, 5, 6]
  for (let iter = 0; iter < 10; iter++) {
    apply(angles)
    const p = anchorPos()
    const q = anchorQuat()
    const ePos = targetPos.clone().sub(p)
    // 姿态误差：targetQuat ⊗ anchorQuat⁻¹ 的旋转矢量
    const qErr = targetQuat.clone().multiply(q.clone().invert()).normalize()
    const eRot = quatToRotVec(qErr)
    if (ePos.length() < 0.0025 && eRot.length() < 0.02) break   // 2.5mm + ~1.1°
    // 6×7 雅可比：前 3 行位置，后 3 行姿态（旋转矢量前向差分）
    const J: number[][] = Array.from({ length: 6 }, () => new Array(7).fill(0))
    for (const j of active) {
      const h = 0.01
      const pert = [...angles]; pert[j] += h; apply(pert)
      const p2 = anchorPos()
      const q2 = anchorQuat()
      J[0][j] = (p2.x - p.x) / h
      J[1][j] = (p2.y - p.y) / h
      J[2][j] = (p2.z - p.z) / h
      const qd = q2.clone().multiply(q.clone().invert()).normalize()
      const rv = quatToRotVec(qd)
      J[3][j] = rv.x / h; J[4][j] = rv.y / h; J[5][j] = rv.z / h
      apply(angles)   // 还原
    }
    // A = JJᵀ + λ²I（6×6），y = A⁻¹e，dθ = Jᵀy
    const A: number[][] = Array.from({ length: 6 }, (_, r) =>
      Array.from({ length: 6 }, (_, c) => {
        let dot = 0
        for (let k = 0; k < 7; k++) dot += J[r][k] * J[c][k]
        return dot + (r === c ? lam2 : 0)
      }))
    const e = [ePos.x, ePos.y, ePos.z, eRot.x, eRot.y, eRot.z]
    const y = solveLinear(A, e)
    for (const j of active) {
      let dth = 0
      for (let r = 0; r < 6; r++) dth += J[r][j] * y[r]
      dth = THREE.MathUtils.clamp(dth, -0.05, 0.05)
      angles[j] = clampJointValue(names[j], angles[j] + dth, robot)
    }
  }
  apply(angles)
  return angles
}

/**
 * P-B 公开包装：按 tool0 目标位姿反解关节角（供 useTeach 点选执行）。
 * 内部自动定位 tool0 link 作 IK 锚点；模型未就绪或解算失败返回原角度。
 */
export function solveTool0IK6D(
  side: 'L' | 'R',
  targetPos: THREE.Vector3,
  targetQuat: THREE.Quaternion,
  angles: number[],
  robot: any,
): number[] {
  const handle = robot?.getObjectByName?.(`tool0_${side}`)
  if (!handle) return angles
  return solveArmIK6D(side, targetPos, targetQuat, angles, robot, handle, null)
}
