/**
 * @file    markers.ts
 * @brief   3D 交互标记系统：关节/底盘/头部控制球 创建 + 悬停高亮 + 屏幕空间命中 + 显隐集合
 * @author Csihan
 * @date    2026-09-02
 *
 * 设计（P3 交互拆分，2026-09-02）：
 *   - 从 useRobot3D.ts 剥离三类控制球（jointMarkers/chassisMarkers/headMarkers）的
 *     创建、悬停、屏幕命中与显隐集合管理，收敛为 createMarkers 工厂；
 *   - 依赖注入：robot（URDF 模型）+ jointPositions（关节值 ref）+ camera/mouse/renderer
 *     （命中几何）+ allLabels/labelObjs（hover 标签注册）；
 *   - 行为「原样迁移」（球尺寸/颜色/挂点/悬停逻辑/命中半径均不改），拖动状态机
 *     （setupJointDrag）留在 useRobot3D，经本模块导出的 find 系列与显隐集合协作；
 *   - 拖动方向校准表（INVERT_JOINTS/CHASSIS_AXIS_SIGN/HEAD_AXIS_SIGN）随迁移保留。
 */

import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Ref } from 'vue'
import { LIFT_MIN_MM, LIFT_MAX_MM, BEND_MIN_DEG, BEND_MAX_DEG, urdfToLiftMm } from '../utils/chassisUnits'

/** 控制球三类：关节（臂）/ 底盘（升降+弯腰）/ 头部（摇头+点头） */
export type MarkerKind = 'joint' | 'chassis' | 'head'

/** 双臂侧：左/右（与协议/URDF 关节名 Joint1~7_L/R 对应）。 */
const ARM_SIDES = ['L', 'R'] as const

/** createMarkers 依赖注入参数（全部来自 useRobot3D 闭包）。 */
export interface MarkersDeps {
  /** URDF 模型对象（getObjectByName 查 link / setJointValues 驱动） */
  robot: any
  /** 关节值 ref（name → rad/m），悬停读数与限位钳制数据源 */
  jointPositions: Ref<Record<string, number>>
  camera: THREE.PerspectiveCamera
  /** 归一化鼠标（由 useRobot3D 的 pointermove 更新） */
  mouse: THREE.Vector2
  renderer: THREE.WebGLRenderer
  /** hover 标签 DOM 注册表（随场景卸载统一 remove） */
  allLabels: HTMLElement[]
  /** hover 标签 CSS2D 对象注册表（含拖动环标签） */
  labelObjs: CSS2DObject[]
  /** —— 容器注入：三类球数组与显隐集合（useRobot3D 既有引用，共享同一份数据）—— */
  jointMarkers: THREE.Mesh[]
  jointHoverLabels: Record<string, CSS2DObject>
  chassisMarkers: THREE.Mesh[]
  chassisHoverLabels: Partial<Record<'lift' | 'bend', CSS2DObject>>
  headMarkers: THREE.Mesh[]
  headHoverLabels: Partial<Record<'yaw' | 'pitch', CSS2DObject>>
  visibleJointMarkers: Set<string>
  visibleHeadMarkers: Set<'yaw' | 'pitch'>
  visibleChassisMarkers: Set<'lift' | 'bend'>
}
/** 标记系统控制器：useRobot3D 创建后持有，供拖动/渲染/双击/E2E 协作。 */
export interface MarkersController {
  jointMarkers: THREE.Mesh[]
  chassisMarkers: THREE.Mesh[]
  headMarkers: THREE.Mesh[]
  jointHoverLabels: Record<string, CSS2DObject>
  chassisHoverLabels: Partial<Record<'lift' | 'bend', CSS2DObject>>
  headHoverLabels: Partial<Record<'yaw' | 'pitch', CSS2DObject>>
  visibleJointMarkers: Set<string>
  visibleHeadMarkers: Set<'yaw' | 'pitch'>
  visibleChassisMarkers: Set<'lift' | 'bend'>
  createChassisMarkers(): void
  createHeadMarkers(): void
  createJointMarkers(): void
  updateJointHover(): void
  updateChassisHover(): void
  updateHeadHover(): void
  findJointMarkerByPointer(radiusPx?: number): THREE.Mesh | null
  findChassisMarkerByPointer(radiusPx?: number): THREE.Mesh | null
  findHeadMarkerByPointer(radiusPx?: number): THREE.Mesh | null
  clampChassisValue(axis: 'lift' | 'bend', value: number): number
  chassisCurrentValue(axis: 'lift' | 'bend'): number
  headCurrentValue(axis: 'yaw' | 'pitch'): number
  /** 卸载释放：几何/材质 dispose（useRobot3D onUnmounted 调用） */
  dispose(): void
}

/** 创建标记系统控制器（原 useRobot3D.ts 对应逻辑原样迁移）。
 *  注：容器（jointMarkers 等数组/集合）由调用方注入并共享——控制器填充的就是
 *  useRobot3D 传入的那份引用，拖动状态机/E2E 等既有调用点零改动。 */
export function createMarkers(deps: MarkersDeps): MarkersController {
  const { robot, jointPositions, camera, mouse, renderer, allLabels, labelObjs } = deps

  // —— 状态容器（useRobot3D 注入的共享引用，不再内部新建）——
  const { jointMarkers, jointHoverLabels, chassisMarkers, chassisHoverLabels,
          headMarkers, headHoverLabels,
          visibleJointMarkers, visibleHeadMarkers, visibleChassisMarkers } = deps

  /** 当前值读取：lift=绝对高度 mm（由 URDF 滑台行程反推）；bend=deg */
  function chassisCurrentValue(axis: 'lift' | 'bend'): number {
    return axis === 'lift'
      ? urdfToLiftMm(jointPositions.value['torso_lift_joint'] ?? 0)
      : (jointPositions.value['torso_pitch_joint'] ?? 0) * 180 / Math.PI
  }

  /** 底盘值域钳位：lift=绝对高度 mm（903.3~1453.3）/ bend=弯腰 °（±90）。 */
  function clampChassisValue(axis: 'lift' | 'bend', value: number): number {
    return axis === 'lift'
      ? Math.min(Math.max(value, LIFT_MIN_MM), LIFT_MAX_MM)
      : Math.min(Math.max(value, BEND_MIN_DEG), BEND_MAX_DEG)
  }

  /** 头部当前角读取（deg）：由 URDF 关节 rad 反推 */
  function headCurrentValue(axis: 'yaw' | 'pitch'): number {
    const rad = jointPositions.value[axis === 'yaw' ? 'head_yaw_joint' : 'head_pitch_joint'] ?? 0
    return rad * 180 / Math.PI
  }

  /** 创建底盘两球：挂在对应 link 上（FK 自动跟随升降/弯腰运动） */
  function createChassisMarkers(): void {
    const specs: Array<{ axis: 'lift' | 'bend'; link: string; color: number; pos: [number, number, number] }> = [
      // 升降球：torso_lift_link 原点在滑台基部（世界 z≈0.15），球放侧面避开躯干网格
      { axis: 'lift', link: 'torso_lift_link', color: 0x34d399, pos: [0.14, 0.10, 0] },
      // 弯腰球：torso_link 原点在俯仰轴心（世界 z≈0.94），球放前侧便于观察俯仰
      { axis: 'bend', link: 'torso_link', color: 0xa855f7, pos: [0.16, 0, 0] },
    ]
    for (const spec of specs) {
      const link = robot.getObjectByName(spec.link)
      if (!link) continue
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.036, 18, 18),
        new THREE.MeshBasicMaterial({
          color: spec.color, transparent: true, opacity: .9,
          depthTest: false, depthWrite: false,
        }),
      )
      marker.name = `chassis_${spec.axis}_marker`
      marker.renderOrder = 999
      marker.position.set(...spec.pos)
      marker.userData.chassisAxis = spec.axis
      marker.userData.chassisLabel = spec.axis === 'lift' ? '升降' : '弯腰'
      marker.visible = false   // 默认隐藏，双击底盘显式出现
      link.add(marker)
      // HUD 悬停标签（复用 joint-hover 样式，挂在球上随球移动）
      const hoverEl = document.createElement('div')
      hoverEl.className = 'joint-hover'
      const hoverObj = new CSS2DObject(hoverEl)
      hoverObj.userData.isHoverLabel = true
      hoverObj.position.set(0, 0.05, 0)
      marker.add(hoverObj)
      chassisHoverLabels[spec.axis] = hoverObj
      allLabels.push(hoverEl)
      chassisMarkers.push(marker)
    }
  }

  /** 创建头部两球：yaw 挂 head_yaw_link（摇头轴系）、pitch 挂 head_link（点头轴系） */
  function createHeadMarkers(): void {
    const specs: Array<{ axis: 'yaw' | 'pitch'; link: string; color: number; pos: [number, number, number] }> = [
      // 摇头球：head_yaw_link 原点即摇头轴，球放前上侧便于水平拖动观察
      { axis: 'yaw', link: 'head_yaw_link', color: 0xffa726, pos: [0.13, 0.05, 0] },
      // 点头球：head_link 原点即点头轴，球放前侧便于垂直拖动
      { axis: 'pitch', link: 'head_link', color: 0xf472b6, pos: [0.15, 0, 0] },
    ]
    for (const spec of specs) {
      const link = robot.getObjectByName(spec.link)
      if (!link) continue
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.034, 18, 18),
        new THREE.MeshBasicMaterial({
          color: spec.color, transparent: true, opacity: .9,
          depthTest: false, depthWrite: false,
        }),
      )
      marker.name = `head_${spec.axis}_marker`
      marker.renderOrder = 999
      marker.position.set(...spec.pos)
      marker.userData.headAxis = spec.axis
      marker.userData.headLabel = spec.axis === 'yaw' ? '摇头' : '点头'
      marker.visible = false   // 默认隐藏，双击头部显式出现
      link.add(marker)
      // HUD 悬停标签（复用 joint-hover 样式，挂在球上随球移动）
      const hoverEl = document.createElement('div')
      hoverEl.className = 'joint-hover'
      const hoverObj = new CSS2DObject(hoverEl)
      hoverObj.userData.isHoverLabel = true
      hoverObj.position.set(0, .05, 0)
      marker.add(hoverObj)
      headHoverLabels[spec.axis] = hoverObj
      labelObjs.push(hoverObj)
      allLabels.push(hoverEl)
      headMarkers.push(marker)
    }
  }
  /** 创建关节球：挂到各关节 child link 原点，跟随 URDF FK 一起运动；做相邻球冲突消解 */
  function createJointMarkers(): void {
    for (const side of ARM_SIDES) {
      for (let i = 1; i <= 7; i++) {
        const jointName = `Joint${i}_${side}`
        const link = robot.getObjectByName(`Link${i}_${side}`)
        if (!link) continue
        const jointAnchor = new THREE.Object3D()
        jointAnchor.name = `${jointName}_anchor`
        link.add(jointAnchor)
        // P0 视觉修正 v2：球沿 link visual 包围盒"最长轴"全量偏移到几何中心，
        // 再做相邻球世界距离冲突消解（home 位姿下肩 J1/J2/J3、腕 J5/J6/J7 轴心重合）。
        const visual = link.children.find((o: any) => (o as THREE.Mesh).isMesh) as THREE.Mesh | undefined
        if (visual) {
          visual.updateMatrix()
          const geo = visual.geometry
          if (geo.boundingBox === null) geo.computeBoundingBox()
          const bb = geo.boundingBox!
          const size = bb.getSize(new THREE.Vector3())
          // 连杆主方向 = 包围盒最长轴（沿臂伸展方向）
          const axis: 'x' | 'y' | 'z' =
            Math.abs(size.x) >= Math.abs(size.y) && Math.abs(size.x) >= Math.abs(size.z) ? 'x'
              : Math.abs(size.y) >= Math.abs(size.z) ? 'y' : 'z'
          const center = bb.getCenter(new THREE.Vector3()).applyMatrix4(visual.matrix)
          jointAnchor.position.set(0, 0, 0)
          jointAnchor.position[axis] = center[axis]
          jointAnchor.userData.spreadAxis = axis
        } else {
          // 兜底：无独立 visual mesh 的 link（此前 J6/J7"消失"的疑似原因）
          console.warn(`[markers] ${jointName} link 无 visual mesh，使用保底偏移`)
          jointAnchor.position.set(0, 0.02 * i, 0)
          jointAnchor.userData.spreadAxis = 'y'
        }
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.031, 18, 18),
          new THREE.MeshBasicMaterial({
            color: 0x31b0e6, transparent: true, opacity: .9,
            depthTest: false, depthWrite: false,
          }),
        )
        marker.name = `${jointName}_marker`
        marker.renderOrder = 999
        marker.userData.jointName = jointName
        marker.userData.jointLabel = `${jointName.endsWith('_L') ? 'L' : 'R'} J${i}`
        marker.visible = false   // 默认隐藏，双击显式出现（双击单关节/整臂）
        jointAnchor.add(marker)
        const hoverEl = document.createElement('div')
        hoverEl.className = 'joint-hover'
        const hoverObj = new CSS2DObject(hoverEl)
        hoverObj.userData.isHoverLabel = true
        hoverObj.position.set(0, .045, 0)
        jointAnchor.add(hoverObj)
        jointHoverLabels[jointName] = hoverObj
        labelObjs.push(hoverObj)
        allLabels.push(hoverEl)
        jointMarkers.push(marker)
      }
    }
    // 冲突消解：FK 更新后检查两两球的世界距离，<5.5cm 沿各自连杆主轴强制推开
    robot.updateMatrixWorld(true)
    for (let iter = 0; iter < 5; iter++) {
      let moved = false
      for (let a = 0; a < jointMarkers.length; a++) {
        for (let b = a + 1; b < jointMarkers.length; b++) {
          const pa = jointMarkers[a].getWorldPosition(new THREE.Vector3())
          const pb = jointMarkers[b].getWorldPosition(new THREE.Vector3())
          if (pa.distanceTo(pb) < 0.055) {
            const anchorB = jointMarkers[b].parent as THREE.Object3D
            const axis = (anchorB.userData.spreadAxis ?? 'y') as 'x' | 'y' | 'z'
            anchorB.position[axis] += anchorB.position[axis] >= 0 ? 0.025 : -0.025
            moved = true
          }
        }
      }
      robot.updateMatrixWorld(true)
      if (!moved) break
    }
    // 注：原 useRobot3D 此处调 setupJointDrag()——解耦后由 useRobot3D 在构造控制器后统一调用
  }

  // —— 悬停状态（与 hit-testing 共用，避免每帧重复 Raycaster）——
  let hoverJoint: string | null = null
  let chassisHover: 'lift' | 'bend' | null = null
  let headHover: 'yaw' | 'pitch' | null = null

  /** 关节球悬停高亮（取消聚焦限制：全景下同样可悬停/直接拖动） */
  function updateJointHover(): void {
    const marker = findJointMarkerByPointer()
    const name = marker?.userData?.jointName ?? null
    if (name === hoverJoint) return
    hoverJoint = name
    jointMarkers.forEach(item => {
      const n = item.userData.jointName as string
      if (!item.visible) {
        const label = jointHoverLabels[n]
        if (label) (label.element as HTMLElement).style.display = 'none'
        return
      }
      const material = item.material as THREE.MeshBasicMaterial
      const active = item.userData.jointName === hoverJoint
      material.color.set(active ? 0xaef9ff : 0x31b0e6)
      material.opacity = active ? 1 : .78
      item.scale.setScalar(active ? 1.4 : 1)
      const labelObj = jointHoverLabels[n]
      if (labelObj) {
        const el = labelObj.element as HTMLElement
        el.style.display = active ? 'block' : 'none'
        el.textContent = active
          ? `${item.userData.jointLabel} · ${(Number(jointPositions.value[n] ?? 0) * 180 / Math.PI).toFixed(1)}°`
          : ''
      }
    })
  }

  /** 底盘球悬停高亮（升降/弯腰，独立避免污染关节高亮逻辑） */
  function updateChassisHover(): void {
    const axis = findChassisMarkerByPointer()?.userData?.chassisAxis ?? null
    if (axis === chassisHover) return
    chassisHover = axis
    for (const m of chassisMarkers) {
      if (!m.visible) continue   // 隐藏的底盘球不参与悬停
      const a = m.userData.chassisAxis as 'lift' | 'bend'
      const active = a === axis
      const mat = m.material as THREE.MeshBasicMaterial
      mat.opacity = active ? 1 : 0.85
      m.scale.setScalar(active ? 1.35 : 1)
      const lab = chassisHoverLabels[a]
      if (lab) {
        const el = lab.element as HTMLElement
        el.style.display = active ? 'block' : 'none'
        if (active) {
          const v = chassisCurrentValue(a)
          el.textContent = a === 'lift' ? `升降 ${Math.round(v)} mm` : `弯腰 ${v.toFixed(1)}°`
        } else el.textContent = ''
      }
    }
  }

  /** 头部球悬停高亮（摇头/点头，与底盘同法） */
  function updateHeadHover(): void {
    const axis = findHeadMarkerByPointer()?.userData?.headAxis ?? null
    if (axis === headHover) return
    headHover = axis
    for (const m of headMarkers) {
      if (!m.visible) continue   // 隐藏的头部球不参与悬停
      const a = m.userData.headAxis as 'yaw' | 'pitch'
      const active = a === axis
      const mat = m.material as THREE.MeshBasicMaterial
      mat.opacity = active ? 1 : 0.85
      m.scale.setScalar(active ? 1.35 : 1)
      const lab = headHoverLabels[a]
      if (lab) {
        const el = lab.element as HTMLElement
        el.style.display = active ? 'block' : 'none'
        el.textContent = active ? `${m.userData.headLabel} ${headCurrentValue(a).toFixed(1)}°` : ''
      }
    }
  }

  /**
   * 关节球做屏幕空间命中：3D Raycaster 在模型密集时容易被遮挡，
   * 而操作球本身就是 HUD 标记，必须优先于模型命中。
   */
  function findJointMarkerByPointer(radiusPx = 34): THREE.Mesh | null {
    const rect = renderer.domElement.getBoundingClientRect()
    let nearest: THREE.Mesh | null = null
    let nearestDistance = radiusPx
    for (const marker of jointMarkers) {
      if (!marker.visible) continue   // 隐藏的球不可命中（默认隐藏策略）
      const projected = marker.getWorldPosition(new THREE.Vector3()).project(camera)
      if (projected.z > 1) continue
      const x = (projected.x * .5 + .5) * rect.width + rect.left
      const y = (-projected.y * .5 + .5) * rect.height + rect.top
      const distance = Math.hypot(x - (mouse.x * .5 + .5) * rect.width - rect.left,
        y - (-mouse.y * .5 + .5) * rect.height + rect.top)
      if (distance < nearestDistance) { nearestDistance = distance; nearest = marker }
    }
    return nearest
  }

  /** 底盘球屏幕空间命中（与关节球同法） */
  function findChassisMarkerByPointer(radiusPx = 40): THREE.Mesh | null {
    const rect = renderer.domElement.getBoundingClientRect()
    let nearest: THREE.Mesh | null = null
    let nearestDistance = radiusPx
    for (const marker of chassisMarkers) {
      if (!marker.visible) continue
      const projected = marker.getWorldPosition(new THREE.Vector3()).project(camera)
      if (projected.z > 1) continue
      const x = (projected.x * .5 + .5) * rect.width + rect.left
      const y = (-projected.y * .5 + .5) * rect.height + rect.top
      const distance = Math.hypot(x - (mouse.x * .5 + .5) * rect.width - rect.left,
        y - (-mouse.y * .5 + .5) * rect.height + rect.top)
      if (distance < nearestDistance) { nearestDistance = distance; nearest = marker }
    }
    return nearest
  }

  /** 头部球屏幕空间命中（与关节球同法） */
  function findHeadMarkerByPointer(radiusPx = 40): THREE.Mesh | null {
    const rect = renderer.domElement.getBoundingClientRect()
    let nearest: THREE.Mesh | null = null
    let nearestDistance = radiusPx
    for (const marker of headMarkers) {
      if (!marker.visible) continue
      const projected = marker.getWorldPosition(new THREE.Vector3()).project(camera)
      if (projected.z > 1) continue
      const x = (projected.x * .5 + .5) * rect.width + rect.left
      const y = (-projected.y * .5 + .5) * rect.height + rect.top
      const distance = Math.hypot(x - (mouse.x * .5 + .5) * rect.width - rect.left,
        y - (-mouse.y * .5 + .5) * rect.height + rect.top)
      if (distance < nearestDistance) { nearestDistance = distance; nearest = marker }
    }
    return nearest
  }

  /** 卸载释放：关节/底盘/头部球几何与材质 dispose */
  function dispose(): void {
    ;[jointMarkers, chassisMarkers, headMarkers].forEach(arr =>
      arr.forEach(m => { m.geometry.dispose(); (m.material as THREE.Material).dispose() }))
  }

  return {
    jointMarkers, chassisMarkers, headMarkers,
    jointHoverLabels, chassisHoverLabels, headHoverLabels,
    visibleJointMarkers, visibleHeadMarkers, visibleChassisMarkers,
    createChassisMarkers, createHeadMarkers, createJointMarkers,
    updateJointHover, updateChassisHover, updateHeadHover,
    findJointMarkerByPointer, findChassisMarkerByPointer, findHeadMarkerByPointer,
    clampChassisValue, chassisCurrentValue, headCurrentValue,
    dispose,
  }
}
