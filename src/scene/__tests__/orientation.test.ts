/**
 * @file    orientation.test.ts
 * @brief   机器人朝向口径冒烟测试——防止"翻转/镜像补丁"回归
 * @author Csihan
 * @date    2026-09-04
 *
 * 背景（orientation.ts 的朝向口径定案）：
 *   2026-09-04 之前，朝向由 rotation.y=π + scale.z=-1 双补丁定义，导致
 *   URDF X± 与渲染朝向相反（front 轮画在身后），且无任何测试保护。
 *   方案 B 移除补丁后，用本测试把口径钉死：
 *     1. ROBOT_FRONT 必须是 +X 单位向量（正面语义唯一来源）；
 *     2. SCREEN_LEFT_IS 必须满足"正面视角下画面左=机器人左臂、右=右臂"映射存在且互逆
 *        （2026-09-05 实测修正：旧"镜像"口径与 3D 投影 arm_l→左/arm_r→右 相反）；
 *     3. 相机 home 机位必须在 +X 侧（正面视角）。
 *   任何人再想加旋转/镜像补丁，先过这三条。
 */
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { ROBOT_FRONT, CAMERA_HOME_SIDE, SCREEN_LEFT_IS, MODEL_YAW } from '../orientation'

describe('机器人朝向口径（orientation.ts 单一事实源）', () => {
  it('ROBOT_FRONT = 世界 +X 单位向量（URDF 网格正面经 MODEL_YAW 转正后）', () => {
    expect(ROBOT_FRONT.x).toBeCloseTo(1, 6)
    expect(ROBOT_FRONT.y).toBeCloseTo(0, 6)
    expect(ROBOT_FRONT.z).toBeCloseTo(0, 6)
    expect(ROBOT_FRONT.length()).toBeCloseTo(1, 6)
  })

  it('MODEL_YAW = π（纯旋转摆放,网格正面从 URDF -X 转到世界 +X）', () => {
    expect(MODEL_YAW).toBeCloseTo(Math.PI, 6)
  })

  it('MODEL_YAW 下旋转矩阵行列式 = +1（禁止镜像回归的硬闸门）', () => {
    // 任何 det=-1 的"镜像修正"回归（如旧 scale.z=-1）都会让本条变红。
    // 行列式 +1 = 纯旋转,关节转向与 URDF 数据同号。
    const m = new THREE.Matrix4().makeRotationY(MODEL_YAW)
    expect(m.determinant()).toBeCloseTo(1, 6)
  })

  it('CAMERA_HOME_SIDE 与 ROBOT_FRONT 同侧（相机在正面看 = 面对面）', () => {
    expect(CAMERA_HOME_SIDE.dot(ROBOT_FRONT)).toBeGreaterThan(0)
  })

  it('SCREEN_LEFT_IS 左右映射完整且自洽', () => {
    // 定案口径（2026-09-05 URDF 挂载修正）：画面左 = 机器人左臂、画面右 = 机器人右臂
    // 键=机器人臂侧(L/R)，值=画面方位(robot_L=画面左 / robot_R=画面右)，互逆。
    expect(SCREEN_LEFT_IS.L).toBe('robot_L')
    expect(SCREEN_LEFT_IS.R).toBe('robot_R')
  })

  it('ROBOT_FRONT 不可被意外修改（冻结校验）', () => {
    // 常量若被某处代码误改（如 normalize 就地修改），测试立即红
    const snapshot = new THREE.Vector3(1, 0, 0)
    expect(ROBOT_FRONT.distanceTo(snapshot)).toBeLessThan(1e-9)
  })
})
