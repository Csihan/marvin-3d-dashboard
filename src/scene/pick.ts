/**
 * @file    pick.ts
 * @brief   3D 部位拾取：Raycaster 命中 + 双击路由（控制球/部位聚焦）+ 部件高亮 + HUD 投屏
 * @author Csihan
 * @date    2026-09-02
 *
 * 设计（Web 整理收尾，2026-09-02）：
 *   - 从 useRobot3D.ts 剥离「Raycaster 点击选择」区（pickPart/updatePointer/onDblClick/
 *     applyPartOpacity/projectPartToScreen）与 linkToPartId 纯映射，行为原样迁移；
 *   - 双击路由优先级（原口径不变）：关节球（单球聚焦+键盘武装）→ 头部球 → 底盘球 →
 *     部位（整臂 7 球 / 头 yaw+pitch / 底盘 lift+bend）→ 双击空白复位全景；
 *   - 依赖注入：find*ByPointer 走 useRobot3D 传入的提升封装（内部读 markersCtl，
 *     规避创建期捕获 null）；显隐集合/选中状态/dragState 由 useRobot3D 共享引用；
 *   - dblclick 事件绑定随控制器注册，清理登记进 deps.eventCleanup（拖动+拾取共用）。
 */

import * as THREE from 'three'
import type { Ref } from 'vue'
import type { DragState } from './drag'

// link 名 → 大屏部位 id（Raycaster 点击与聚焦淡化用）
function linkToPartId(linkName: string): string {
  if (linkName.includes('gripper_L')) return 'grip_l'
  if (linkName.includes('gripper_R')) return 'grip_r'
  if (linkName.endsWith('_L')) return 'arm_l'
  if (linkName.endsWith('_R')) return 'arm_r'
  if (linkName.includes('head')) return 'head'
  if (linkName.includes('torso')) return 'torso'
  return 'chassis'   // base_link / 轮 / 转向 / 相机等其余全部归底盘
}
/** 部位拾取依赖注入参数（全部来自 useRobot3D 闭包）。 */
export interface PickDeps {
  renderer: THREE.WebGLRenderer
  camera: THREE.PerspectiveCamera
  container: HTMLElement
  mouse: THREE.Vector2
  robotGroup: THREE.Group
  placeholderGroup: THREE.Group
  modelLoaded: Ref<boolean>
  selectedPart: Ref<{ id: string; label: string } | null>
  focusMode: Ref<boolean>
  visibleJointMarkers: Set<string>
  visibleHeadMarkers: Set<'yaw' | 'pitch'>
  visibleChassisMarkers: Set<'lift' | 'bend'>
  applyMarkerVisibility: () => void
  findJointMarkerByPointer: (radiusPx?: number) => THREE.Mesh | null
  findHeadMarkerByPointer: (radiusPx?: number) => THREE.Mesh | null
  findChassisMarkerByPointer: (radiusPx?: number) => THREE.Mesh | null
  dragState: DragState
  eventCleanup: Array<() => void>
  flyTo: (target: THREE.Object3D) => void
  resetToHome: () => void
  options: {
    onJointSelect?: (jointName: string) => void
    onPartSelect?: (partId: string) => void
  }
}

/** 拾取控制器：useRobot3D 持有，applyPartOpacity/projectPartToScreen 薄转发入口。 */
export interface PickController {
  applyPartOpacity(partId: string | null): void
  projectPartToScreen(partId: string): { x: number; y: number } | null
}

/** 创建部位拾取控制器（原 useRobot3D 对应逻辑原样迁移）。 */
export function createPickController(deps: PickDeps): PickController {
  // ═══ Raycaster 点击选择（自 useRobot3D 迁入，行为原样）═══
  const raycaster = new THREE.Raycaster()
  // mouse/eventCleanup 由 deps 注入（拾取与拖动状态机共写 mouse；清理登记共用）
  function pickTargets(): THREE.Object3D[] {
    // 真模型优先；加载失败时用兜底占位可点
    return deps.modelLoaded.value ? [deps.robotGroup] : [deps.placeholderGroup]
  }
  function pickPart(): { object: THREE.Object3D; partId: string } | null {
    raycaster.setFromCamera(deps.mouse, deps.camera)
    const hits = raycaster.intersectObjects(pickTargets(), true)
    if (hits.length === 0) return null
    const obj = hits[0].object
    // 从 mesh 向上找第一个有 link 名的节点（URDF 加载回调写入 userData.linkName）
    let linkName = ''
    let p: THREE.Object3D | null = obj
    while (p && !linkName) {
      linkName = (p.userData as any)?.linkName || ''
      if (!linkName && p.name) linkName = p.name   // URDF link 节点本身有名字
      p = p.parent
    }
    const partId = linkName ? linkToPartId(linkName) : 'chassis'
    return { object: obj, partId }
  }

  function updatePointer(e: MouseEvent): void {
    const rect = deps.renderer.domElement.getBoundingClientRect()
    deps.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    deps.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
  }

  /** 双击聚焦：只有双击模型才进入局部，双击空白回全景，避免单击和拖关节冲突。 */
  function onDblClick(e: MouseEvent): void {
    updatePointer(e)
    // 双击某控制球 → 只保留该球并聚焦（关节/头部/底盘三类同逻辑，2026-08-30）
    const marker = deps.findJointMarkerByPointer(34)
    if (marker?.userData?.jointName) {
      const jointName = marker.userData.jointName as string
      // 2026-08-30：双击单个关节球 → 只显示该关节的球（其余隐藏），聚焦进键盘微调
      deps.visibleJointMarkers.clear()
      deps.visibleHeadMarkers.clear()
      deps.visibleChassisMarkers.clear()
      deps.visibleJointMarkers.add(jointName)
      deps.applyMarkerVisibility()
      deps.selectedPart.value = { id: jointName, label: marker.userData.jointLabel }
      deps.focusMode.value = true
      const side = jointName.endsWith('_L') ? 'L' : 'R'
      // 2026-08-31 修复（键盘控制根因之一）：双击既设 HUD(kb-hud) 也要真正武装键盘微调。
      // 此前只 onJointSelect 显示键位提示，未设 deps.dragState.kbSelected，导致按说明「双击关节球→进入
      // 键盘微调」后按 W/S 无任何反应——注释写着"聚焦进键盘微调"但状态从未建立。
      deps.dragState.kbSelected = { side, index: Number(jointName.match(/^Joint(\d)/)?.[1] ?? 1) - 1 }
      applyPartOpacity(side === 'L' ? 'arm_l' : 'arm_r')
      deps.flyTo(marker)
      deps.options.onJointSelect?.(jointName)
      return
    }
    const headHit = deps.findHeadMarkerByPointer(40)
    if (headHit?.userData?.headAxis) {
      const axis = headHit.userData.headAxis as 'yaw' | 'pitch'
      deps.visibleJointMarkers.clear()
      deps.visibleHeadMarkers.clear()
      deps.visibleChassisMarkers.clear()
      deps.visibleHeadMarkers.add(axis)
      deps.applyMarkerVisibility()
      deps.selectedPart.value = { id: `head_${axis}`, label: headHit.userData.headLabel }
      deps.focusMode.value = true
      applyPartOpacity('head')
      deps.flyTo(headHit)
      deps.options.onPartSelect?.('head')
      return
    }
    const chassisHit = deps.findChassisMarkerByPointer(40)
    if (chassisHit?.userData?.chassisAxis) {
      const axis = chassisHit.userData.chassisAxis as 'lift' | 'bend'
      deps.visibleJointMarkers.clear()
      deps.visibleHeadMarkers.clear()
      deps.visibleChassisMarkers.clear()
      deps.visibleChassisMarkers.add(axis)
      deps.applyMarkerVisibility()
      deps.selectedPart.value = { id: `chassis_${axis}`, label: chassisHit.userData.chassisLabel }
      deps.focusMode.value = true
      applyPartOpacity('chassis')
      deps.flyTo(chassisHit)
      deps.options.onPartSelect?.('chassis')
      return
    }
    const hit = pickPart()
    if (!hit) {
      deps.resetToHome()
      return
    }
    // 2026-08-30：双击整臂 → 该臂 7 球；双击头部 → yaw+pitch 两球；
    // 双击躯干/底盘 → lift+bend 两球；双击其他部位 → 清空全部隐藏
    deps.visibleJointMarkers.clear()
    deps.visibleHeadMarkers.clear()
    deps.visibleChassisMarkers.clear()
    if (hit.partId === 'arm_l' || hit.partId === 'arm_r') {
      const side = hit.partId === 'arm_l' ? 'L' : 'R'
      for (let i = 1; i <= 7; i++) deps.visibleJointMarkers.add(`Joint${i}_${side}`)
    } else if (hit.partId === 'head') {
      deps.visibleHeadMarkers.add('yaw')
      deps.visibleHeadMarkers.add('pitch')
    } else if (hit.partId === 'torso' || hit.partId === 'chassis') {
      deps.visibleChassisMarkers.add('lift')
      deps.visibleChassisMarkers.add('bend')
    }
    deps.applyMarkerVisibility()
    deps.selectedPart.value = { id: hit.partId, label: hit.partId }
    deps.focusMode.value = true
    applyPartOpacity(hit.partId)
    deps.flyTo(hit.object)
    deps.options.onPartSelect?.(hit.partId)
  }
  deps.renderer.domElement.addEventListener('dblclick', onDblClick)
  deps.eventCleanup.push(() => deps.renderer.domElement.removeEventListener('dblclick', onDblClick))

  function applyPartOpacity(partId: string | null): void {
    deps.robotGroup.traverse(obj => {
      const mesh = obj as THREE.Mesh
      if (!mesh.isMesh) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      const own = linkToPartId(mesh.name || (mesh.parent?.name ?? '')) === partId
      materials.forEach(m => {
        m.transparent = true
        m.opacity = !partId || own ? 1 : 0.15
      })
    })
  }

  /** 供 SVG HUD 连接线使用：把部位包围盒中心投到 CSS 像素坐标。 */
  function projectPartToScreen(partId: string): { x: number; y: number } | null {
    let target: THREE.Object3D | null = null
    const center = new THREE.Vector3()
    const box = new THREE.Box3()
    deps.robotGroup.traverse(obj => {
      if ((obj as THREE.Mesh).isMesh && linkToPartId(obj.name || (obj.parent?.name ?? '')) === partId) {
        box.expandByObject(obj)
        target = obj
      }
    })
    if (!target || box.isEmpty()) return null
    box.getCenter(center).project(deps.camera)
    return {
      x: (center.x * .5 + .5) * deps.container.clientWidth,
      y: (-center.y * .5 + .5) * deps.container.clientHeight,
    }
  }

  return { applyPartOpacity, projectPartToScreen }
}
