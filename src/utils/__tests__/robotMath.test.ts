/**
 * @file    robotMath.test.ts
 * @brief   utils/robotMath 纯函数单测：线性求解、四元数、DLS 核心、角度钳制
 * @author Csihan
 * @date    2026-09-01
 */
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  solve3x3, solveLinear, quatToRotVec, dlsStep, clampAngle,
  DEG2RAD, RAD2DEG,
} from '../robotMath'

describe('solve3x3（3×3 高斯消元）', () => {
  it('单位矩阵返回原右端向量', () => {
    const A = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    expect(solve3x3(A, [2, 3, 4])).toEqual([2, 3, 4])
  })

  it('普通 3×3 系统解正确', () => {
    // x + y + z = 6, 2y + 5z = -4, 2x + 5y - z = 27 → (x=5, y=3, z=-2)
    const A = [[1, 1, 1], [0, 2, 5], [2, 5, -1]]
    const x = solve3x3(A, [6, -4, 27])
    expect(x[0]).toBeCloseTo(5, 9)
    expect(x[1]).toBeCloseTo(3, 9)
    expect(x[2]).toBeCloseTo(-2, 9)
  })

  it('奇异矩阵不产生 NaN（0 兜底）', () => {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    const x = solve3x3(A, [1, 1, 1])
    expect(x.every(v => Number.isFinite(v))).toBe(true)
  })
})

describe('solveLinear（N×N 高斯消元）', () => {
  it('4×4 系统解正确（含主元交换路径）', () => {
    const A = [
      [2, 1, -1, 0],
      [0, 1, 3, -2],
      [3, -1, 0, 1],
      [1, 0, 2, 3],
    ]
    const b = [4, 5, 3, 6]
    const x = solveLinear(A, b)
    // 回代验证 A·x ≈ b
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let c = 0; c < 4; c++) s += A[r][c] * x[c]
      expect(s).toBeCloseTo(b[r], 8)
    }
  })

  it('6×6 对角阵返回右端', () => {
    const A = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 6 }, (_, j) => (i === j ? 1 : 0)))
    const b = [1, -2, 3, -4, 5, -6]
    expect(solveLinear(A, b)).toEqual(b)
  })

  it('奇异矩阵不产生 NaN', () => {
    const A = Array.from({ length: 3 }, () => [0, 0, 0])
    const x = solveLinear(A, [1, 2, 3])
    expect(x.every(v => Number.isFinite(v))).toBe(true)
  })
})

describe('quatToRotVec（四元数 → 旋转矢量）', () => {
  it('单位四元数（零旋转）返回零向量', () => {
    const v = quatToRotVec(new THREE.Quaternion())
    expect(v.length()).toBeCloseTo(0, 9)
  })

  it('绕 Z 轴 90° 四元数返回 (0,0,π/2)', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)
    const v = quatToRotVec(q)
    expect(v.x).toBeCloseTo(0, 8)
    expect(v.y).toBeCloseTo(0, 8)
    expect(v.z).toBeCloseTo(Math.PI / 2, 8)
  })

  it('w 越界输入被钳制（容忍未归一化）', () => {
    const v = quatToRotVec(new THREE.Quaternion(0, 0, 0, 2))
    expect(v.length()).toBe(0)
  })
})

describe('dlsStep（阻尼最小二乘单步）', () => {
  it('单位雅可比 + 零误差返回零增量', () => {
    const J = Array.from({ length: 3 }, (_, r) =>
      Array.from({ length: 7 }, (_, c) => (r === c ? 1 : 0)))
    const dth = dlsStep(J, [0, 0, 0], [0, 1, 2])
    expect(dth.every(v => Math.abs(v) < 1e-9)).toBe(true)
  })

  it('单关节可完全补偿：误差全落在该关节列 → 增量 ≈ 误差/雅可比（含阻尼缩比）', () => {
    // 只有关节 3 生效（J[:,3] = [2,0,0]），误差 e=[0.02,0,0]。
    // DLS：A = JJᵀ + λ²I，A[0][0] = 2² + 0.0025 = 4.0025，y0 = 0.02/4.0025，
    //      dθ3 = J[0][3]·y0 = 2·0.02/4.0025 ≈ 0.0099938（阻尼使解略小于理想 0.01）
    const J = Array.from({ length: 3 }, () => new Array(7).fill(0))
    J[0][3] = 2
    const dth = dlsStep(J, [0.02, 0, 0], [3])
    expect(dth[3]).toBeCloseTo(2 * 0.02 / (4 + 0.0025), 6)
  })

  it('多关节共同作用时解落在最小范数方向（阻尼平滑：均按 1/(1+λ²) 缩比）', () => {
    const J = Array.from({ length: 3 }, (_, r) =>
      Array.from({ length: 7 }, (_, c) => (r === c ? 1 : 0)))
    const dth = dlsStep(J, [0.1, 0.2, 0.3], [0, 1, 2, 3, 4, 5, 6])
    // 全关节参与、对角雅可比：A = (1+λ²)I，dθ_i = e_i/(1+λ²)（阻尼项统一缩比）
    const k = 1 / (1 + 0.0025)
    expect(dth[0]).toBeCloseTo(0.1 * k, 6)
    expect(dth[1]).toBeCloseTo(0.2 * k, 6)
    expect(dth[2]).toBeCloseTo(0.3 * k, 6)
  })

  it('屏蔽关节增量恒为 0', () => {
    const J = Array.from({ length: 3 }, () => new Array(7).fill(1))
    const dth = dlsStep(J, [1, 1, 1], [0])
    expect(dth[1]).toBe(0)
    expect(dth[6]).toBe(0)
  })
})

describe('clampAngle（角度钳制）', () => {
  it('在限位内原样返回', () => {
    expect(clampAngle(0.5, -1, 1)).toBeCloseTo(0.5, 12)
  })

  it('超过上限/下限被截断', () => {
    expect(clampAngle(2, -1, 1)).toBeCloseTo(1, 12)
    expect(clampAngle(-2, -1, 1)).toBeCloseTo(-1, 12)
  })

  it('限位缺失时返回原值', () => {
    expect(clampAngle(5, null, null)).toBeCloseTo(5, 12)
  })
})

describe('角度常量', () => {
  it('DEG2RAD × RAD2DEG = 1', () => {
    expect(DEG2RAD * RAD2DEG).toBeCloseTo(1, 12)
  })
})
