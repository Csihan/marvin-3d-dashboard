/**
 * @file    camera.ts
 * @brief   相机控制模块：聚焦飞行动画（flyTo）+ 全景复位（resetToHome）+ 初始视角快照
 * @author Csihan
 * @date    2026-09-01
 *
 * 设计（P3 交互拆分，2026-09-01）：
 *   - 从 useRobot3D.ts 剥离 flyTo/resetToHome/homeView，收敛为 createCameraController 工厂；
 *   - 依赖注入：camera / controls / focusMode(ref) / homeView 快照 + onResetScene（复位场景
 *     标记显隐）与 onReset（App 侧回调）两个副作用钩子；
 *   - 行为「原样迁移」（GSAP 动画参数/杀 tween 顺序/相机侧保持逻辑均不改），
 *     保证双击聚焦与 ESC 复位的动画手感与重构前一致。
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import gsap from 'gsap'
import type { Ref } from 'vue'

/** 相机控制器：useRobot3D 持有并暴露 flyTo/resetToHome。 */
export interface CameraController {
  /** 双击聚焦：把相机飞到目标包围盒（保持当前侧向，不翻转）。 */
  flyTo(target: THREE.Object3D): void
  /** 全景复位：杀动画 → 清标记显隐 → 相机/目标回 homeView。 */
  resetToHome(): void
}

/** createCameraController 依赖注入。 */
export interface CameraDeps {
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  /** 聚焦模式（3D 内部 focusMode ref，复位时置 false）。 */
  focusMode: Ref<boolean>
  /** 初始视角快照（构造时克隆，复位目标）。 */
  homeView: { camera: THREE.Vector3; target: THREE.Vector3 }
  /** 复位场景副作用：清空三类控制球显隐并应用（标记系统回调）。 */
  onResetScene: () => void
  /** App 侧复位回调（options.onReset）。 */
  onReset?: () => void
}

/** 创建相机控制器（原 useRobot3D.ts flyTo/resetToHome 原样迁移）。 */
export function createCameraController(deps: CameraDeps): CameraController {
  const { camera, controls, focusMode, homeView, onResetScene, onReset } = deps

  /** GSAP 相机飞行动画：双击聚焦到目标。 */
  function flyTo(target: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(target)
    if (box.isEmpty()) return
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3())
    const dist = Math.max(size.x, size.y, size.z) * 2.5 + 0.3
    // 保持相机在当前这一侧（不翻转），只是拉近到目标
    const dir = camera.position.clone().sub(controls.target).normalize()
    focusMode.value = true
    controls.enabled = false
    // 同时动画相机位置和 controls.target
    gsap.to(camera.position, {
      x: center.x + dir.x * dist,
      y: Math.max(center.y + dir.y * dist, center.y + 0.2),  // 防止钻入地下
      z: center.z + dir.z * dist,
      duration: 1.0, ease: 'power2.inOut',
    })
    gsap.to(controls.target, {
      x: center.x, y: center.y, z: center.z,
      duration: 1.0, ease: 'power2.inOut',
      onComplete: () => { controls.enabled = true },
    })
  }

  /** 复位回全景默认态（Esc/双击空白/关闭 Inspector 都走这里）。 */
  function resetToHome(): void {
    // 复位回全景默认态 → 三类控制球全部隐藏（"默认隐藏、双击显式出现"口径）
    onResetScene()
    // P0 修复：先杀掉所有相机/目标动画（此前 resetView + resetToHome 两个 tween
    // 同时驱动 camera.position 互相打架，导致 ESC 后回不到初始位）。
    gsap.killTweensOf(camera.position)
    gsap.killTweensOf(controls.target)
    focusMode.value = false
    onReset?.()
    controls.enabled = false
    gsap.to(camera.position, {
      ...homeView.camera, duration: .65, ease: 'power2.inOut',
      onUpdate: () => camera.lookAt(controls.target),
      onComplete: () => { controls.enabled = true },
    })
    gsap.to(controls.target, { ...homeView.target, duration: .65, ease: 'power2.inOut' })
  }

  return { flyTo, resetToHome }
}
