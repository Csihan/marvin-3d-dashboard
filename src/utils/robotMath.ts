/**
 * @file    robotMath.ts
 * @brief   机械臂 IK/数学纯函数库：线性求解、四元数工具、阻尼最小二乘核心
 * @author Csihan
 * @date    2026-09-01
 *
 * 设计原则（P1 纯函数提取，2026-09-01）：
 *   - 本模块只包含「无副作用」的纯函数：输入输出确定、不碰 DOM/场景图/Vue ref，
 *     可独立单测、可被任意后端/节点直接引用；
 *   - 实现一律「原样迁移」自 useRobot3D.ts（solve3x3/solveLinear/quatToRotVec），
 *     不重写算法，保证 Web 拖动手感与重构前逐位一致；
 *   - 依赖：仅复用 three.js 数学类（Vector3/Quaternion/MathUtils），不引入新依赖。
 */

import * as THREE from 'three'

/** 度 → 弧度（协议与 SDK 均以 rad 为主，显示层才转 deg） */
export const DEG2RAD = Math.PI / 180
/** 弧度 → 度 */
export const RAD2DEG = 180 / Math.PI

/**
 * 解 3×3 线性方程组 A·x = b（高斯消元，列主元 + 部分主元选择）。
 * @param A 3×3 系数矩阵
 * @param b 3 维右端向量
 * @return  3 维解向量（奇异时对应行用 0 兜底，避免 NaN 传播）
 * @note   原实现位于 useRobot3D.ts solveArmIK（3D 位置 IK 的 DLS 核心），原样迁移。
 */
export function solve3x3(A: number[][], b: number[]): number[] {
  const m = [A[0].concat(b[0]), A[1].concat(b[1]), A[2].concat(b[2])]
  for (let col = 0; col < 3; col++) {
    let piv = col
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    if (Math.abs(m[piv][col]) < 1e-9) continue
    ;[m[col], m[piv]] = [m[piv], m[col]]
    for (let r = 0; r < 3; r++) {
      if (r === col) continue
      const f = m[r][col] / m[col][col]
      for (let c = col; c < 4; c++) m[r][c] -= f * m[col][c]
    }
  }
  return [0, 1, 2].map(r => m[r][3] / (Math.abs(m[r][r]) < 1e-9 ? 1 : m[r][r]))
}

/**
 * 解 N×N 线性方程组 A·x = b（高斯消元，带主元选择；DLS 已加阻尼视为非奇异）。
 * @param A N×N 系数矩阵
 * @param b N 维右端向量
 * @return  N 维解向量（奇异时对应行用 0 兜底）
 * @note   原实现位于 useRobot3D.ts solveArmIK6D（6D IK 需要 6×6 求解），原样迁移。
 */
export function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length
  const m = A.map((row, r) => [...row, b[r]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r
    if (Math.abs(m[piv][col]) < 1e-9) continue
    ;[m[col], m[piv]] = [m[piv], m[col]]
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = m[r][col] / m[col][col]
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c]
    }
  }
  return Array.from({ length: n }, (_, r) =>
    m[r][n] / (Math.abs(m[r][r]) < 1e-9 ? 1 : m[r][r]))
}

/**
 * 四元数 → 旋转矢量（轴角 × 角度），用于姿态误差度量。
 * @param q 单位四元数（w 超出 [-1,1] 会被钳制，容忍未归一化输入）
 * @return  旋转矢量（长度 = 旋转角度 rad；零旋转返回零向量）
 * @note   原实现位于 useRobot3D.ts solveArmIK6D（姿态误差行），原样迁移。
 */
export function quatToRotVec(q: THREE.Quaternion): THREE.Vector3 {
  const w = THREE.MathUtils.clamp(q.w, -1, 1)
  const angle = 2 * Math.acos(w)
  const s = Math.sqrt(Math.max(0, 1 - w * w))
  if (s < 1e-9) return new THREE.Vector3(0, 0, 0)
  return new THREE.Vector3(q.x / s, q.y / s, q.z / s).multiplyScalar(angle)
}

/**
 * 阻尼最小二乘（DLS）单步解算：给定雅可比 J 与误差 e，返回关节角增量 dθ。
 * 公式：A = JJᵀ + λ²I，y = A⁻¹e，dθ = Jᵀy。
 * @param J      m×7 雅可比矩阵（m=3 位置 IK 或 m=6 位置+姿态 IK）
 * @param err    m 维误差向量（目标 - 当前，单位 m 或 rad）
 * @param active 参与解算的关节序号集（可跳过被屏蔽关节，减少 0 列）
 * @param lambda 阻尼系数（默认 0.05，对应 λ²=0.0025——奇异位形附近防数值爆炸）
 * @return       7 维增量数组（未参与关节恒为 0；未钳制，由调用方做限位/步幅钳制）
 * @note        数学核心来自 useRobot3D.ts solveArmIK/solveArmIK6D，抽为通用纯函数。
 */
export function dlsStep(
  J: number[][],
  err: number[],
  active: number[],
  lambda = 0.05,
): number[] {
  const m = err.length
  const lam2 = lambda * lambda
  const n = J[0]?.length ?? 7
  // A = JJᵀ + λ²I（m×m 对称正定，加阻尼保证可逆）
  const A: number[][] = Array.from({ length: m }, (_, r) =>
    Array.from({ length: m }, (_, c) => {
      let dot = 0
      for (let k = 0; k < n; k++) dot += J[r][k] * J[c][k]
      return dot + (r === c ? lam2 : 0)
    }))
  const y = m === 3 ? solve3x3(A, err) : solveLinear(A, err)
  // dθ = Jᵀy：逐关节累加雅可比行内积
  const dth = new Array(n).fill(0)
  for (const j of active) {
    let acc = 0
    for (let r = 0; r < m; r++) acc += J[r][j] * y[r]
    dth[j] = acc
  }
  return dth
}

/**
 * 关节角钳制到 [min,max]（rad）。限位缺失时返回原值，避免误伤未配置关节。
 * @param value  当前角度（rad）
 * @param min    下限（rad，可空）
 * @param max    上限（rad，可空）
 */
export function clampAngle(value: number, min: number | null, max: number | null): number {
  let v = value
  if (min !== null && Number.isFinite(min)) v = Math.max(v, min)
  if (max !== null && Number.isFinite(max)) v = Math.min(v, max)
  return v
}
