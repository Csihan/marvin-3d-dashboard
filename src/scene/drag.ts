/**
 * @file    drag.ts
 * @brief   3D 交互拖动状态机：关节球/腕部拖动环/头部球/底盘球统一拖动会话 + 键盘微调
 * @author Csihan
 * @date    2026-09-02
 *
 * 设计（P3 拖动拆分，2026-09-02）：
 *   - 从 useRobot3D.ts 剥离 setupJointDrag（484 行）为独立模块，行为「原样迁移」；
 *   - 统一拖动会话三阶段（begin/update/end）+ 命中路由（头/底盘/拖动环/关节球）
 *     + 键盘微调（W/S/Q/E/A/D/Tab/Space）+ 滚轮推拉深度 + 双击前伸工作位 + 场景级防误触；
 *   - 依赖注入：只读依赖走 DragDeps（camera/mouse/controls/renderer/robotGroup/
 *     jointPositions/jointMarkers/defaultCamPos（仅机位快照，朝向语义见 orientation.ts）/
 *     options/eventCleanup + 各类解算/预览/
 *     命中/钳制函数 + 常量），共享可变状态走 DragState（activeDrag/kbSelected/
 *     draggingArm/lastDragEndAt/dragHandles/dragModeActive）——useRobot3D 与本模块
 *     共享同一份 state 引用，反馈抑制/到位判定/拖动模式 UI 等跨模块读写保持一致；
 *   - 拖动方向校准表（INVERT_JOINTS/CHASSIS_AXIS_SIGN/HEAD_AXIS_SIGN）已单点固化在
 *     本模块（2026-09-02 从 useRobot3D 收敛，删 deps 过路字段），真机对照后在此调整。
 */

import * as THREE from 'three'
import type { Ref } from 'vue'

/** 拖动环交互档位：pos=位置跟随 / angle=空间角度 / multi=链动 */
export type DragMode = 'pos' | 'angle' | 'multi'

/** 统一拖动会话：关节球/拖动环/头部球/底盘球共用同一状态机（2026-08-30 重构） */
export interface DragSession {
  kind: 'joint' | 'handle' | 'head' | 'chassis'
  pointerId: number
  // 通用
  startX: number; startY: number
  lastX: number; lastY: number
  lastSend: number
  // 臂（joint / handle）
  side?: 'L' | 'R'
  jointName?: string              // joint 专用
  jointIndex?: number             // joint 专用
  mode?: DragMode                 // handle 专用
  startWorld?: THREE.Vector3      // handle：按下时锚点世界位置
  startQuat?: THREE.Quaternion    // handle：按下时 tool0 世界姿态
  depthOff?: THREE.Vector3        // handle：滚轮深度累积
  right?: THREE.Vector3; up?: THREE.Vector3   // handle：相机平面基向量
  angles?: number[]               // arm 工作数组（rad，7 关节）
  // 轴控制（head / chassis）
  axis?: 'yaw' | 'pitch' | 'lift' | 'bend'
  startVal?: number               // 按下时当前值
}

/** 共享可变状态：useRobot3D 与本模块共享同一引用（反馈抑制/到位判定/M4 UI 跨模块读） */
export interface DragState {
  activeDrag: DragSession | null
  kbSelected: { side: 'L' | 'R'; index: number } | null
  draggingArm: 'L' | 'R' | null
  lastDragEndAt: number
  dragHandles: Partial<Record<'L' | 'R', THREE.Mesh>>
  dragModeActive: Record<'L' | 'R', boolean>
}

// 方向校准表已抽离到 jointCalibration.ts（避免 drag↔ik 循环依赖）
import { shouldInvert } from './jointCalibration'
// 机器人正面方向常量（2026-09-04 方案 B）：双击前伸的目标方位从这里取
import { ROBOT_FRONT } from './orientation'
// 键盘笛卡尔 Jog 状态机（2026-09-05 任务：示教模式六轴飞控）
import {
  createJogLoop, jogKeyDown, jogKeyUp, jogActive, jogApplyKey,
  setJogStepLevel, jogThrottled, jogClearAll,
} from './jogCartesian'
export const CHASSIS_AXIS_SIGN: Record<'lift' | 'bend', 1 | -1> = { lift: 1, bend: 1 }
export const HEAD_AXIS_SIGN: Record<'yaw' | 'pitch', 1 | -1> = { yaw: 1, pitch: 1 }

/** 拖动状态机依赖注入参数（全部来自 useRobot3D 闭包）。 */
export interface DragDeps {
  renderer: THREE.WebGLRenderer
  mouse: THREE.Vector2
  camera: THREE.PerspectiveCamera
  /** OrbitControls（禁用/启用 + 缩放让位滚轮推拉） */
  controls: any
  robotGroup: THREE.Group
  jointPositions: Ref<Record<string, number>>
  jointMarkers: THREE.Mesh[]
  defaultCamPos: THREE.Vector3
  /** 命令回调（关节流/头部/底盘/键盘 HOME） */
  options: {
    onJointCommand?: (cmd: { arm: 1 | 2; jointName: string; jointAnglesRad: number[] }) => void
    onHeadCommand?: (cmd: { axis: 'yaw' | 'pitch'; value: number }) => void
    onChassisCommand?: (cmd: { axis: 'lift' | 'bend'; value: number }) => void
    onHomeRequest?: (side: 'L' | 'R') => void
  }
  eventCleanup: Array<() => void>
  // —— 函数依赖 ——
  registerPending: (jointName: string, angle: number) => void
  clampJointValue: (jointName: string, value: number) => number
  currentArmAngles: (side: 'L' | 'R') => number[]
  /** FK 正解：tool0 世界位姿（Jog 6D 目标取当前末端位姿起点） */
  computeTool0: (side: 'L' | 'R') => { pos: THREE.Vector3; quat: THREE.Quaternion } | null
  findHeadMarkerByPointer: () => THREE.Mesh | null
  findChassisMarkerByPointer: () => THREE.Mesh | null
  findJointMarkerByPointer: () => THREE.Mesh | null
  findDragHandleByPointer: () => THREE.Mesh | null
  headCurrentValue: (axis: 'yaw' | 'pitch') => number
  chassisCurrentValue: (axis: 'lift' | 'bend') => number
  clampChassisValue: (axis: 'lift' | 'bend', value: number) => number
  previewChassis: (axis: 'lift' | 'bend', value: number) => void
  previewHead: (axis: 'yaw' | 'pitch', deg: number) => void
  solveArmIK: (side: 'L' | 'R', targetWorld: THREE.Vector3, angles: number[],
               handle: THREE.Object3D, mask: number[] | null) => number[]
  solveTool0IK6D: (side: 'L' | 'R', targetWorld: THREE.Vector3,
                   quat: THREE.Quaternion, angles: number[]) => number[]
  /** Jog 状态变更上报（App HUD 订阅步长档位/激活状态，可选手动拖动时忽略） */
  onJogStateChange?: (s: { stepLevel: number; active: boolean }) => void
  /** 示教激活判定（2026-09-06 TEACH-MODE-CONVERGE 解法 A 注入）：
   *  由 App.vue 装配时把 teach.teaching 注入（箭头函数延迟读取，防 useTeach↔useRobot3D
   *  循环依赖——与 onJogStateChange 同款单向注入范式）。键盘踩点模式不发 mode_switch
   *  state=4（走位置模式指令流），后端不会回显 M4，jogEnabled 必须靠本回调识别该模式。 */
  isTeachActive?: () => boolean
  // —— 常量 ——
  ARM_JOINTS: readonly string[]
  ARM_SIDES: readonly ('L' | 'R')[]
  DEG2RAD: number
}

  export function setupDragHandling(deps: DragDeps, state: DragState): void {
    const dom = deps.renderer.domElement
    let markerHit: THREE.Mesh | null = null

    const setPointer = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect()
      deps.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
      deps.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    }

    // 键盘微调的当前选中关节声明已上移到外层（见 clearKbSelection 注释）

    // ═══ 统一拖动会话：三阶段（begin/update/end）═══
    // 2026-08-30 彻底重构：替代 dragState/ikState/headDrag/chassisDrag 四套状态。
    //   beginDrag(session)   —— 命中路由后统一入场（指针捕获/禁相机/清键盘选中）
    //   state.activeDrag.update(e) —— 按 kind 分发到各自移动逻辑（统一节流 + 统一出口）
    //   state.activeDrag.end(e)    —— 统一收尾（补发终值/归还相机/进反馈缓冲）
    function beginDrag(s: DragSession): void {
      state.activeDrag = s
      if (s.side) state.draggingArm = s.side          // 反馈抑制：拖动臂标记
      if (s.side) state.kbSelected = null             // 换控制对象，清残留键盘选中
      deps.controls.enabled = false
      if (s.kind === 'handle') deps.controls.enableZoom = false   // 滚轮让位深度推拉
      // 指针捕获：拖出画布仍能持续接收 move/up。若指针无活动捕获目标（合成事件、
      // 极端时序下指针已释放）会抛 NotFoundError——捕获只是增强手段，失败不应
      // 阻断整个拖动会话，故 try/catch 吞掉（2026-08-30 防御性修复）。
      try { dom.setPointerCapture(s.pointerId) } catch { /* 无活动指针时跳过捕获 */ }
    }
    /** 统一收尾：任意拖动松手都走这里（幂等，window 兜底安全） */
    function endDrag(e: PointerEvent): void {
      if (!state.activeDrag || state.activeDrag.pointerId !== e.pointerId) return
      const s = state.activeDrag
      // 按 kind 补发最终目标（拖动过程中节流可能丢了最后一帧）
      if (s.kind === 'handle' || s.kind === 'joint') {
        if (s.side && s.angles && deps.options.onJointCommand) {
          deps.options.onJointCommand({
            arm: s.side === 'L' ? 1 : 2,
            jointName: s.kind === 'joint' ? (s.jointName ?? `TCP_${s.side}`) : `TCP_${s.side}`,
            jointAnglesRad: [...s.angles],
          })
        }
      } else if (s.kind === 'head' && s.axis) {
        deps.options.onHeadCommand?.({ axis: s.axis as 'yaw' | 'pitch', value: deps.headCurrentValue(s.axis as 'yaw' | 'pitch') })
      } else if (s.kind === 'chassis' && s.axis) {
        deps.options.onChassisCommand?.({ axis: s.axis as 'lift' | 'bend', value: deps.chassisCurrentValue(s.axis as 'lift' | 'bend') })
      }
      state.activeDrag = null
      state.draggingArm = null
      state.lastDragEndAt = performance.now()         // 400ms 反馈缓冲（统一抑制）
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId)
      deps.controls.enabled = true
      deps.controls.enableZoom = true
    }
    /** 统一臂命令下发（节流 30Hz，走 topic 流） */
    function sendArmCommand(s: DragSession, jointName: string): void {
      const now = performance.now()
      if (now - s.lastSend < 33 || !s.side || !s.angles || !deps.options.onJointCommand) return
      s.lastSend = now
      deps.options.onJointCommand({
        arm: s.side === 'L' ? 1 : 2,
        jointName,
        jointAnglesRad: [...s.angles],
      })
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return
      setPointer(e)
      // ── 命中路由（优先级：头部球 → 底盘球 → 拖动环 → 关节球）──
      // 头部球：Alt/Shift+左键才拖，纯左键放行相机
      const headHit = deps.findHeadMarkerByPointer()
      if (headHit && (e.altKey || e.shiftKey)) {
        e.stopPropagation()
        beginDrag({
          kind: 'head',
          axis: headHit.userData.headAxis as 'yaw' | 'pitch',
          pointerId: e.pointerId,
          startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
          startVal: deps.headCurrentValue(headHit.userData.headAxis as 'yaw' | 'pitch'),
          lastSend: 0,
        })
        return
      }
      // 底盘球：Alt/Shift+左键才拖，纯左键放行相机（升降/弯腰不允许裸左键）
      const chassisHit = deps.findChassisMarkerByPointer()
      if (chassisHit && (e.altKey || e.shiftKey)) {
        e.stopPropagation()
        beginDrag({
          kind: 'chassis',
          axis: chassisHit.userData.chassisAxis as 'lift' | 'bend',
          pointerId: e.pointerId,
          startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
          startVal: deps.chassisCurrentValue(chassisHit.userData.chassisAxis as 'lift' | 'bend'),
          lastSend: 0,
        })
        return
      }
      // 拖动环：唯一腕部 TCP 环
      const handle = deps.findDragHandleByPointer()
      if (handle) {
        const side = handle.userData.side as 'L' | 'R'
        e.stopPropagation()
        // 档位（2026-08-30 单环改版）：纯左键=位置跟随 / Shift=空间角度 / Alt=多动角度
        const mode: DragMode = e.shiftKey ? 'angle' : (e.altKey ? 'multi' : 'pos')
        // 姿态基准：tool0 世界姿态（Shift 空间角度需要，按下时快照）
        const tool0Obj = (deps.robotGroup.children[0] as any)?.getObjectByName?.(`tool0_${side}`)
        const startQuat = tool0Obj
          ? tool0Obj.getWorldQuaternion(new THREE.Quaternion())
          : handle.getWorldQuaternion(new THREE.Quaternion())
        beginDrag({
          kind: 'handle',
          side, mode,
          pointerId: e.pointerId,
          startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
          startWorld: handle.getWorldPosition(new THREE.Vector3()),
          startQuat,
          depthOff: new THREE.Vector3(),
          right: new THREE.Vector3().setFromMatrixColumn(deps.camera.matrixWorld, 0).normalize(),
          up: new THREE.Vector3().setFromMatrixColumn(deps.camera.matrixWorld, 1).normalize(),
          angles: deps.currentArmAngles(side), lastSend: 0,
        })
        return
      }
      // 关节球：Alt/Shift+左键才拖（纯左键放行相机），并记录键盘微调选中
      markerHit = deps.findJointMarkerByPointer()
      const jointName = markerHit?.userData?.jointName
      if (!markerHit || !jointName) return
      if (!(e.altKey || e.shiftKey)) return
      e.stopPropagation()
      const side = jointName.endsWith('_L') ? 'L' : 'R'
      state.kbSelected = { side, index: Number(jointName.match(/^Joint(\d)/)?.[1] ?? 1) - 1 }
      beginDrag({
        kind: 'joint',
        side, jointName, jointIndex: state.kbSelected.index,
        pointerId: e.pointerId,
        startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
        angles: deps.currentArmAngles(side), lastSend: 0,
      })
    }

    const onPointerMove = (e: PointerEvent) => {
      setPointer(e)
      const s = state.activeDrag
      if (!s || s.pointerId !== e.pointerId) return
      s.lastX = e.clientX
      s.lastY = e.clientY
      // ── 按 kind 统一分发：handle（拖动环）/ head（头部球）/ chassis（底盘球）/ joint（关节球）──
      if (s.kind === 'handle') {
        // 拖动环 IK：pos=位置跟随(纯左键)/ angle=空间角度(Shift)/ multi=链动(Alt)
        const rect = dom.getBoundingClientRect()
        const dx = e.clientX - s.startX
        const dy = e.clientY - s.startY
        // 屏幕像素 → 世界位移：按手柄按下时到相机的距离换算（透视比例）
        const dist = deps.camera.position.distanceTo(s.startWorld!)
        const worldPerPixel = 2 * Math.tan(THREE.MathUtils.degToRad(deps.camera.fov / 2)) * dist / rect.height
        const side = s.side!
        if (s.mode === 'pos') {
          // 纯左键：腕端位置跟随——相机平面拖动，整臂 7 关节 IK（主交互，灵敏度 0.5×）
          const scale = 0.5
          const target = s.startWorld!.clone()
            .addScaledVector(s.right!, dx * worldPerPixel * scale)
            .addScaledVector(s.up!, -dy * worldPerPixel * scale)
            .add(s.depthOff!)
          s.angles = runIk(side, s.angles!, target)
        } else if (s.mode === 'angle') {
          // Shift：空间角度——位置锁起点+深度，只旋转末端姿态（6D IK）
          const targetPos = s.startWorld!.clone().add(s.depthOff!)
          const q = s.startQuat!.clone()
          q.multiply(new THREE.Quaternion().setFromAxisAngle(s.up!, -dx * 0.008))
          q.multiply(new THREE.Quaternion().setFromAxisAngle(s.right!, dy * 0.008))
          const solved = deps.solveTool0IK6D(side, targetPos, q, s.angles!)
          s.angles = applyDragSolution(side, solved, s.angles!)
        } else {
          // Alt：多动角度——J2~J7 链动微调（真机约束，单帧钳制防跳变）
          const d = dy * 0.0008                     // 链动步长（rad/px，很小的量）
          const chain = [...s.angles!]
          for (let i = 1; i < 7; i++) {
            const w = (7 - i) / 6                   // J2 权重最高 → J7 最低（链动衰减）
            chain[i] = deps.clampJointValue(`${deps.ARM_JOINTS[i]}_${side}`, chain[i] + d * w)
          }
          s.angles = applyDragSolution(side, chain, s.angles!)
        }
        sendArmCommand(s, `TCP_${side}`)
        return
      }
      // ── 头部球：yaw 水平 / pitch 垂直，Alt=精细；±90° 钳位；120ms 节流 ──
      if (s.kind === 'head') {
        const axis = s.axis as 'yaw' | 'pitch'
        let step = 0.15
        if (e.altKey) step *= 0.1
        let px = axis === 'yaw' ? e.clientX - s.startX : s.startY - e.clientY
        if (HEAD_AXIS_SIGN[axis] === -1) px = -px
        const value = Math.min(Math.max(s.startVal! + px * step, -90), 90)
        deps.previewHead(axis, value)
        const now = performance.now()
        if (now - s.lastSend >= 120 && deps.options.onHeadCommand) {
          s.lastSend = now
          deps.options.onHeadCommand({ axis, value })
        }
        return
      }
      // ── 底盘球：垂直位移 → 升降 mm / 弯腰 °；Alt=精细；120ms 节流 ──
      if (s.kind === 'chassis') {
        const axis = s.axis as 'lift' | 'bend'
        const pixels = s.startY - e.clientY
        let step = axis === 'lift' ? 0.6 : 0.18
        if (e.altKey) step *= 0.1
        if (CHASSIS_AXIS_SIGN[axis] === -1) step = -step
        const value = deps.clampChassisValue(axis, s.startVal! + pixels * step)
        deps.previewChassis(axis, value)
        const now = performance.now()
        if (now - s.lastSend >= 120 && deps.options.onChassisCommand) {
          s.lastSend = now
          deps.options.onChassisCommand({ axis, value })
        }
        return
      }
      // ── 关节球：垂直拖动 = 单轴/链动调角；统一走 applyDragSolution（限位+单帧钳制）──
      const side = s.side!
      const jointName = s.jointName!
      const jointIndex = s.jointIndex!
      const pixels = s.startY - e.clientY
      let delta = pixels * 0.05 * deps.DEG2RAD          // 灵敏度（原 0.12 步进太大，用户反馈）
      if (e.altKey) delta *= 0.1
      // 注意：方向校准现在在模型侧（applyDragSolution 的 setJointValues 处）
      // 统一处理，不在命令侧取反——真机方向是正确的，只需修正模型显示方向。
      const affected = e.shiftKey ? deps.ARM_JOINTS.map((_, i) => i).filter(i => i >= jointIndex) : [jointIndex]
      const next = [...s.angles!]
      affected.forEach(i => {
        const name = `${deps.ARM_JOINTS[i]}_${side}`
        next[i] = deps.clampJointValue(name, next[i] + delta)
      })
      s.angles = applyDragSolution(side, next, s.angles!)
      sendArmCommand(s, jointName)
    }

    /** IK 解算 + 模型投影 + pending 登记（不含流下发，调用方按节流发送）。
     *  唯一腕部手柄：整臂 7 关节 IK 跟随。
     *  2026-08-30 重构：改走统一出口 applyDragSolution——单帧增量钳制 + deps.jointPositions
     *  同步，消除 DLS 大步收敛跳变与"angle/multi 档 seed 读到旧值"的一致性 bug。 */
    function runIk(side: 'L' | 'R', angles: number[], target: THREE.Vector3): number[] {
      const handle = state.dragHandles[side]
      if (!handle) return angles
      const solved = deps.solveArmIK(side, target, angles, handle, null)
      return applyDragSolution(side, solved, angles)
    }

    /** ═══ 统一拖动解算出口（2026-08-30 重构，替代 4 处分散下发）═══
     *  职责：① 单帧增量钳制（每关节每次至多 ±DRAG_STEP_RAD，真机速度上限的视觉映射）；
     *        ② 关节限位钳制（SDK 限位，真机约束）；③ 模型投影 setJointValues；
     *        ④ deps.jointPositions 同步（保证下一次 IK seed=deps.currentArmAngles 读到本帧结果）；
     *        ⑤ deps.registerPending（本地预览优先于 ROS 反馈，防松手回弹）。
     *  所有拖动档（pos/angle/multi/键盘步进/双击前伸/滚轮推拉）统一走此入口。 */
    const DRAG_STEP_RAD = 1 * deps.DEG2RAD            // 单帧每关节最大变化 ±1°（平滑限速）
    function applyDragSolution(side: 'L' | 'R', next: number[], prev: number[],
                               maxStepRad = DRAG_STEP_RAD): number[] {
      const clamped = next.map((v, i) => {
        const name = `${deps.ARM_JOINTS[i]}_${side}`
        const limited = deps.clampJointValue(name, v)              // ① SDK 限位
        const d = limited - prev[i]                           // ② 单帧增量
        // 2026-08-31：最大步长参数化——指针拖动/fastIK 默认 1°/帧平滑限速；
        // 键盘点按是离散指令，传完整步长（Shift+W=3°）一次到位，否则会被削成 1°。
        const stepped = prev[i] + THREE.MathUtils.clamp(d, -maxStepRad, maxStepRad)
        return deps.clampJointValue(name, stepped)
      })
      const names = deps.ARM_JOINTS.map(n => `${n}_${side}`)
      const robot = deps.robotGroup.children[0] as any
      // ★ 2026-09-03 模型侧方向校准：URDF 左右臂定义相同，但真机对向安装，
      //   导致模型显示的旋转方向与真机相反（J1/J3 等）。在 setJointValues 时
      //   对模型侧取反，命令侧（clamped/jointPositions）保持不变，真机不受影响。
      robot?.setJointValues(Object.fromEntries(names.map((n, i) => {
        const baseName = n.replace(/_[LR]$/, '')
        const modelAngle = shouldInvert(side, baseName) ? -clamped[i] : clamped[i]
        return [n, modelAngle]
      })))  // ③
      names.forEach((n, i) => {                               // ④⑤
        deps.jointPositions.value[n] = clamped[i]
        deps.registerPending(n, clamped[i])
      })
      return clamped
    }

    const onPointerUp = (e: PointerEvent) => {
      // 统一收尾：任意拖动松手都走 endDrag（补发终值/归还相机/进反馈缓冲，幂等）
      endDrag(e)
    }

    // ── 滚轮推拉深度：仅拖住手柄时接管（解决"拖动点在身后够不着"），
    //    滚轮向上=拉近、向下=推远，步长按视距比例缩放；此时相机缩放已临时关闭。──
    const onWheel = (e: WheelEvent) => {
      const s = state.activeDrag
      if (!s || s.kind !== 'handle' || !s.startWorld) return
      e.preventDefault()
      const dist = deps.camera.position.distanceTo(s.startWorld)
      const step = -Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0007 * dist
      const forward = new THREE.Vector3()
      deps.camera.getWorldDirection(forward)
      s.depthOff!.addScaledVector(forward, step)
      // 用最近一次指针偏移 + 新深度重建目标，避免滚轮瞬间目标回跳
      const rect = dom.getBoundingClientRect()
      const worldPerPixel = 2 * Math.tan(THREE.MathUtils.degToRad(deps.camera.fov / 2)) * dist / rect.height
      const scale = e.shiftKey ? 0.15 : 0.5
      const target = s.startWorld.clone()
        .addScaledVector(s.right!, (s.lastX - s.startX) * worldPerPixel * scale)
        .addScaledVector(s.up!, -(s.lastY - s.startY) * worldPerPixel * scale)
        .add(s.depthOff!)
      s.angles = runIk(s.side!, s.angles!, target)
      sendArmCommand(s, `TCP_${s.side}`)
    }

    // ── 双击手柄：前伸到"胸前工作位"（解决手柄默认在躯干侧后方的起手体验）──
    const onDblClick = (e: MouseEvent) => {
      setPointer(e as unknown as PointerEvent)
      const handle = deps.findDragHandleByPointer()
      if (!handle) return
      e.stopPropagation()
      const side = handle.userData.side as 'L' | 'R'
      // 机器人正面方向 = 单一事实源 ROBOT_FRONT（scene/orientation.ts，X+）。
      // 2026-09-04 方案 B：不再从相机位置反推（旧实现把初始机位掺进几何定义，
      // 换机位即漂移；其 Z+ 兜底也与主口径冲突），直接取坐标约定常量。
      const center = new THREE.Vector3()
      new THREE.Box3().setFromObject(deps.robotGroup).getCenter(center)
      const front = ROBOT_FRONT.clone()
      const shoulder = deps.jointMarkers.find(m => m.userData.jointName === `Joint2_${side}`)
      const base = shoulder
        ? shoulder.getWorldPosition(new THREE.Vector3())
        : center
      const target = base.clone()
        .addScaledVector(front, 0.32)           // 肩前 32cm：胸前可观察工作位
        .add(new THREE.Vector3(0, 0.03, 0))
      const solved = runIk(side, deps.currentArmAngles(side), target)
      if (deps.options.onJointCommand) {
        deps.options.onJointCommand({
          arm: side === 'L' ? 1 : 2,
          jointName: `TCP_${side}`,
          jointAnglesRad: solved,
        })
      }
      state.lastDragEndAt = performance.now()         // 防反馈把前伸动画往回拽
    }

    // ── 键盘微调（用户口径"键盘与鼠标结合"）：
    //    点击关节球选中 → W/S=±0.5°（Ctrl=±0.05°）、A/D/Tab=切关节、Q/E=肩抬降、Space=HOME ──
    const KB_FINE = 0.05     // Ctrl 档步进（deg）
    const KB_STEP = 0.5      // 常规档步进（deg）
    const KB_BIG = 3         // Shift 档大步（deg）：与 kb-hud / HelpGuide 文案 "Shift+W/S ±3°" 对齐

    // ── 2026-08-30（用户#1）：拖动环键盘步进——纯左键已禁用整臂拖动，位置跟随改由键盘承担。
    //    Shift + W/S/A/D 或 ↑↓←→：在相机平面按小步长移动 TCP（慢步进 2mm/次），
    //    复用 runIk（整臂 7 关节跟随），与指针拖动同一套真机约束/钳制。──
    const KB_HANDLE_STEP = 0.002   // 2mm/次（真机示教安全步长）
    /** 判定键盘步进/Jog 作用的臂：优先正在指针拖动的臂，其次 M4 拖动臂，
     *  最后键盘踩点模式（teaching，无 M4 回显）下默认左臂。
     *  2026-09-06（TEACH-MODE-CONVERGE）：键控踩点不发 state=4 → dragModeActive
     *  全空 → 不补这条兜底则 activeHandleSide 返回 null，W/S/Q/E 六轴全部无响应
     *  （Jog 启用了却找不到作用臂，等于白启用）。默认 'L' 与示教面板 side 默认值对齐；
     *  单击关节球可精确切换作用臂（kbSelected 优先级在前）。 */
    function activeHandleSide(): 'L' | 'R' | null {
      if (state.draggingArm) return state.draggingArm
      // 2026-09-02（双臂 M4 支持）：两侧同时处于 M4 时，优先键盘选中臂、否则取第一侧——
      // 后端已支持双臂独立模式（ArmSetMode.arm 1/2 透传），键盘步进需有确定作用臂。
      if (state.kbSelected) return state.kbSelected.side
      const sides = deps.ARM_SIDES.filter(s => state.dragModeActive[s])
      if (sides.length) return sides[0]
      // 键盘踩点模式兜底（2026-09-06）：无 M4 回显时靠 isTeachActive 识别示教语境
      return deps.isTeachActive?.() === true ? 'L' : null
    }
    /** 键盘步进 TCP：沿相机平面 right/up 轴平移目标点 → IK 解算 → 模型投影 + 命令下发。 */
    function keyboardStepHandle(side: 'L' | 'R', dx: number, dy: number): void {
      const handle = state.dragHandles[side]
      if (!handle) return
      const right = new THREE.Vector3().setFromMatrixColumn(deps.camera.matrixWorld, 0).normalize()
      const up = new THREE.Vector3().setFromMatrixColumn(deps.camera.matrixWorld, 1).normalize()
      const target = handle.getWorldPosition(new THREE.Vector3())
        .addScaledVector(right, dx)
        .addScaledVector(up, dy)
      const solved = runIk(side, deps.currentArmAngles(side), target)
      if (deps.options.onJointCommand) {
        deps.options.onJointCommand({
          arm: side === 'L' ? 1 : 2,
          jointName: `TCP_${side}`,
          jointAnglesRad: [...solved],
        })
      }
      state.lastDragEndAt = performance.now()   // 抑制反馈回拽（与指针拖动同口径）
    }

    // ═══ 键盘笛卡尔 Jog（2026-09-05 任务 TEACH-KEYBOARD-JOG，替代 3D 鼠标拖拽）═══
    // 需求（用户口径）：
    //   W/S 沿相机视线推进/撤出（水平投影），A/D 机器人左右横移（世界 +Y/-Y 是左侧），
    //   R/F 竖直升降（世界 +Z/-Z），Q/E 末端偏航（绕世界 Z），Z/X 末端俯仰（绕世界 Y）；
    //   1/2/3 切换步长；按住持续移动、松开即停。
    // 实现要点：
    //   - 复用 jogCartesian 纯状态机（pressed 集合 + 档位 + 节流），本处只负责
    //     「键→轴映射的坐标系语义」「IK 解算」「命令下发」三件事；
    //   - W/S 的"视线方向"取相机 forward 的水平投影（推进/撤出直觉）；
    //   - Q/E、Z/X 旋转在 tool0 当前世界姿态上叠加增量 → 6D IK 反解（solveTool0IK6D）；
    //   - 帧循环用 requestAnimationFrame：节流 30Hz（jogThrottled），按档位累加目标
    //     translate/yaw/pitch → 每帧解算下发；keyup 移出 pressed 后循环自然停止。
    const JOG = createJogLoop()
    let jogRafId = 0
    // 上一帧累计目标记录（增量语义：本帧增量 = 当前累计 - 上一帧累计，防目标漂移）
    let jogPrevTx = 0, jogPrevTy = 0, jogPrevTz = 0, jogPrevYaw = 0, jogPrevPitch = 0
    /** 键 → Jog 轴映射（键名用 e.key 小写；数字键 1/2/3 由 onKeyDown 单独处理档位） */
    const JOG_KEYMAP: Record<string, { axis: 'tx' | 'ty' | 'tz' | 'ry' | 'rp'; sign: 1 | -1 }> = {
      w: { axis: 'tx', sign: 1 },   // 相机视线 推进
      s: { axis: 'tx', sign: -1 },  // 相机视线 撤出
      a: { axis: 'ty', sign: -1 },  // 世界 -Y（机器人左）
      d: { axis: 'ty', sign: 1 },   // 世界 +Y（机器人右）
      r: { axis: 'tz', sign: 1 },   // 世界 +Z 上升
      f: { axis: 'tz', sign: -1 },  // 世界 -Z 下降
      q: { axis: 'ry', sign: 1 },   // 偏航 +（逆时针俯视）
      e: { axis: 'ry', sign: -1 },  // 偏航 -
      z: { axis: 'rp', sign: 1 },   // 俯仰 +
      x: { axis: 'rp', sign: -1 },  // 俯仰 -
    }
    /** 当前 Jog 的启用前提：处于 M4（协作释放）或示教前端态（键盘踩点）。
     *  2026-09-05 判定口径：M4 即示教底层状态——useTeach.enterTeach 的协议实现
     *  就是 mode_switch state=4（RELEASE，配合末端按钮使能输出），dragModeActive
     *  由后端 /robot/status 回显驱动（见 useRobot3D updateDragModeUI）。
     *  2026-09-06（TEACH-MODE-CONVERGE 解法 A，必选）：示教拆成两种进入方式后，
     *  键盘踩点模式（enterTeachKeyboard）**不发 state=4**——臂留在位置模式走指令流，
     *  后端不回显 M4 → 仅靠 dragModeActive 判定会使 Jog 永久禁用（联动断链）。
     *  因此扩展为「dragModeActive || isTeachActive()」：isTeachActive 由 App.vue
     *  装配时注入 teach.teaching（参照 onJogStateChange 的单向注入，防循环依赖），
     *  人手拖动（发 state=4）时二者同时为真，语义并集幂等无副作用。 */
    function jogEnabled(): boolean {
      return deps.ARM_SIDES.some(s => state.dragModeActive[s])
        || deps.isTeachActive?.() === true
    }
    /** 归一化相机水平视线（用于 W/S 推进方向） */
    function cameraForwardH(): THREE.Vector3 {
      const f = new THREE.Vector3()
      deps.camera.getWorldDirection(f)
      f.y = 0
      if (f.lengthSq() < 1e-6) f.set(0, 0, 1)   // 俯视极限兜底：退回世界 Z
      return f.normalize()
    }
    /** 按本帧增量构造 6D 目标（增量语义，防目标漂移，见 jogTick 注释）：
     *  位置 = tool0 当前位置 + 本帧世界位移（W/S→水平相机视线、A/D→世界 Y、R/F→世界 Z）；
     *  姿态 = tool0 当前姿态 依次链乘 世界 Z 偏航增量 / 世界 Y 俯仰增量。 */
    function jogBuildDeltaTarget(
      side: 'L' | 'R',
      dTx: number, dTy: number, dTz: number, dYaw: number, dPitch: number,
    ): { pos: THREE.Vector3; quat: THREE.Quaternion } | null {
      const t0 = deps.computeTool0(side)
      if (!t0) return null
      // 平移方向映射：translate.x 语义="沿相机水平视线"（W/S 推进/撤出直觉），
      //  translate.y 语义="世界左右"（A/D 横移），translate.z 语义="世界竖直"（R/F 升降）。
      const fwd = cameraForwardH()
      const pos = t0.pos.clone()
      pos.addScaledVector(fwd, dTx)
      pos.y += dTy
      pos.z += dTz
      // 姿态：在 tool0 当前世界 quat 上叠加「世界 Z 偏航 + 世界 Y 俯仰」增量。
      // 用欧拉角重建会丢失原有 roll，故用四元数链乘（局部旋转的直觉是"末端自转"，
      // 需求中"末端偏航/俯仰旋转"正是此语义）。premultiply = 世界系左乘。
      // ⚠ 累计增量语义：dYaw/dPitch 是相对起始姿态的累计差，叠加到当前位姿即
      //   "相对当前姿态转增量角"，不会加倍（每帧当前位姿已含上一帧旋转）。
      const q = t0.quat.clone()
      if (dYaw !== 0) {
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), dYaw))
      }
      if (dPitch !== 0) {
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dPitch))
      }
      return { pos, quat: q.normalize() }
    }
    /** 执行一帧 Jog：累加当前按住键 → 6D IK → 命令下发（节流 30Hz 由调用帧控制）。 */
    function jogTick(side: 'L' | 'R'): void {
      if (!jogActive(JOG)) return
      // 先按当前按住的所有键累加一次目标（每帧每个键 += 一档）
      for (const key of JOG.pressed) jogApplyKey(JOG, JOG_KEYMAP, key)
      // ⚠ 目标漂移防护（2026-09-05）：JOG.target 是"相对起始位的累计命令"，
      //   若直接以「tool0当前位置 + 累计」为目标，每帧 tool0 都因上一帧 IK 实际前移，
      //   累计值被二次叠加 → 实际位移 0.01+0.02+0.03…（加速漂移），与步长档位语义不符。
      //   正确做法：本帧增量 = 当前累计 - 上一帧累计，只把增量叠加到「当前 tool0 位姿」。
      //   位置增量转成世界矢量（视线进退/左右/竖直语义在 jogBuildDeltaTarget 内处理）。
      let dTx = JOG.target.translate.x - jogPrevTx
      let dTy = JOG.target.translate.y - jogPrevTy
      let dTz = JOG.target.translate.z - jogPrevTz
      let dYaw = JOG.target.yaw - jogPrevYaw
      let dPitch = JOG.target.pitch - jogPrevPitch
      // 更新"上一帧"记录：即使某帧因节流跳过，这里在每帧 jogTick 开头同步，
      // 后续未被执行的帧已经累积差值——需要「以当前实际位姿 + 差值」才不漂移，
      // 故用 deltas 计算目标后立即把全量 target 同步到 prev（见函数末尾）。
      jogPrevTx = JOG.target.translate.x; jogPrevTy = JOG.target.translate.y; jogPrevTz = JOG.target.translate.z
      jogPrevYaw = JOG.target.yaw; jogPrevPitch = JOG.target.pitch
      const target = jogBuildDeltaTarget(side, dTx, dTy, dTz, dYaw, dPitch)
      if (!target) return
      // seed 复用同一快照：solveTool0IK6D 以它为迭代起点，applyDragSolution 以它为
      // prev 做单帧增量钳制——两头必须同源，否则钳制会以"上一帧结果"做基准产生抖振。
      const seed = deps.currentArmAngles(side)
      const solved = deps.solveTool0IK6D(side, target.pos, target.quat, seed)
      // 🔴-1 修复（2026-09-05 QA-1）：Jog 步长不得被 applyDragSolution 默认 ±1°/帧
      // 平滑钳制二次限速——档 2=2°、档 3=5° 会被削平，档位切换失效（速度全成 1°/帧）。
      // Jog 速率已由 30Hz 节流 + 每帧增量控制，这里只放开「单帧增量钳制」，
      // 仍保留 clampJointValue 的 SDK 限位。maxDelta 取本次解算的实际最大增量
      // （下限 0.01rad 兜底空数组/全零），使 1/2/3 档位转角速度真有差异。
      const maxDelta = Math.max(...solved.map((v, i) => Math.abs(v - seed[i])), 0.01)
      const clamped = applyDragSolution(side, solved, seed, maxDelta)
      if (deps.options.onJointCommand) {
        deps.options.onJointCommand({
          arm: side === 'L' ? 1 : 2,
          jointName: `TCP_${side}`,
          jointAnglesRad: [...clamped],
        })
      }
      state.lastDragEndAt = performance.now()
    }
    /** 键盘 Jog 循环（rAF）：只有 Jog 激活且未 pause 时持续运行；命令节流 30Hz。 */
    function jogLoop(now: number): void {
      if (jogActive(JOG) && !jogThrottled(JOG, now, 33)) {
        const side = activeHandleSide()
        if (side) jogTick(side)
      }
      jogRafId = requestAnimationFrame(jogLoop)
    }
    function jogStartLoop(): void {
      if (jogRafId === 0) jogRafId = requestAnimationFrame(jogLoop)
    }
    function jogStopLoop(): void {
      if (jogRafId !== 0) {
        cancelAnimationFrame(jogRafId)
        jogRafId = 0
      }
    }
    /** 键盘 Jog keydown 入口：按键映射 + 档位切换 + 启动循环。
     *  仅在「Jog 能启用（示教/M4）」且「未选中关节球（W/A/S/D 等归关节微调）」时生效，
     *  与现有 Shift+WASD TCP 步进分支并列但更低优先级——纯 Jog 不需 Shift 修饰。 */
    function keyboardJogOnKeyDown(e: KeyboardEvent): boolean {
      const side = activeHandleSide()
      if (!side || !jogEnabled()) return false
      // 数字键 1/2/3：切换档位（即使当前没有按住运动键也要生效）
      const lv = Number(e.key)
      if (lv >= 1 && lv <= 3) {
        setJogStepLevel(JOG, lv)
        deps.onJogStateChange?.({ stepLevel: JOG.stepLevel, active: jogActive(JOG) })
        e.preventDefault()
        return true
      }
      const key = e.key.toLowerCase()
      if (!(key in JOG_KEYMAP)) return false
      // 关节被选中时 WASD 归关节微调（不进入 Jog），Q/E 也应让位肩抬降
      if (state.kbSelected && ['w', 's', 'a', 'd'].includes(key)) return false
      // Jog 与 Shift+WASD 步进互斥：Shift 组合保留原有行为
      if (e.shiftKey || e.altKey || e.ctrlKey) return false
      jogKeyDown(JOG, key)
      deps.onJogStateChange?.({ stepLevel: JOG.stepLevel, active: true })
      e.preventDefault()
      jogStartLoop()
      return true
    }
    /** 键盘 Jog keyup 入口：移除按住键；全部松开时 HUD 上报 inactive（循环由 rAF 退出）。 */
    function keyboardJogOnKeyUp(e: KeyboardEvent): boolean {
      const key = e.key.toLowerCase()
      if (!(key in JOG_KEYMAP)) return false
      if (!JOG.pressed.has(key)) return false
      jogKeyUp(JOG, key)
      if (!jogActive(JOG)) {
        deps.onJogStateChange?.({ stepLevel: JOG.stepLevel, active: false })
        jogStopLoop()   // 立即停循环，避免最后一帧空转
      }
      return true
    }

    function jogJoint(side: 'L' | 'R', index: number, deltaDeg: number): void {
      // 2026-08-30 重构：统一走 applyDragSolution——构造全 7 关节数组（只改目标关节），
      // 由统一出口做 SDK 限位钳制 + 单帧增量钳制 + deps.jointPositions 同步 + deps.registerPending。
      const name = `${deps.ARM_JOINTS[index]}_${side}`
      const target = deps.jointPositions.value[name] ?? 0
      const next = deps.clampJointValue(name, target + deltaDeg * deps.DEG2RAD)
      const all = deps.ARM_JOINTS.map((n, i) =>
        i === index ? next : (deps.jointPositions.value[`${n}_${side}`] ?? 0))
      const clamped = applyDragSolution(side, all, deps.currentArmAngles(side),
        Math.abs(deltaDeg * deps.DEG2RAD))  // 键盘点按按完整步长执行（不受 1°/帧平滑钳制）
      if (deps.options.onJointCommand) {
        deps.options.onJointCommand({
          arm: side === 'L' ? 1 : 2,
          jointName: name,
          jointAnglesRad: clamped,
        })
      }
      state.lastDragEndAt = performance.now()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      // ══ 键盘笛卡尔 Jog 分支（2026-09-05）：在 sceneBusy 判定之后、原有分支之前。
      //    提前 return 的防护：Jog 需要按住持续，输入框聚焦时绝不驱动（sceneBusy）。
      //    注意：Jog 分支内部自己判断 kbSelected/Jog 启用前提，不在这里统一短路。──
      // 2026-09-05 修复：sceneBusy 是后面的 let 声明，但 onKeyDown 运行时已初始化，
      //   故这里可直接读取（函数体执行时序晚于模块初始化）。
      if (!sceneBusy && keyboardJogOnKeyDown(e)) return
      // 2026-08-30（用户#1）：Shift + WASD/方向键 = 拖动环位置步进（慢步进 2mm）。
      // 置于 state.kbSelected 之前：拖动模式下不选中关节球也能用键盘控 TCP。
      const stepSide = activeHandleSide()
      // 2026-08-31 修复（键盘优先级）：选中关节后键盘归该关节（Shift+W=±3° 大步），
      // 只有「未选中关节」且处于 M4 拖动时才走 Shift+WASD TCP 步进——
      // 此前 TCP 分支在前，选中左臂关节按 Shift+W 会被右臂 M4 的 TCP 步进劫持。
      // sceneBusy：焦点在可编辑元素时短路 JS 驱动矩阵（见下方防误触注释块）。
      // 注意此处不能直接 return——TCP 步进与关节步进两个分支都要吃到防护。
      if (!state.kbSelected && stepSide && e.shiftKey && !e.altKey && !e.ctrlKey && !sceneBusy) {
        let dx = 0, dy = 0
        switch (e.key.toLowerCase()) {
          case 'w': case 'arrowup':    dy =  KB_HANDLE_STEP; break
          case 's': case 'arrowdown':  dy = -KB_HANDLE_STEP; break
          case 'a': case 'arrowleft':  dx = -KB_HANDLE_STEP; break
          case 'd': case 'arrowright': dx =  KB_HANDLE_STEP; break
          default: dx = 0; dy = 0
        }
        if (dx !== 0 || dy !== 0) {
          e.preventDefault()
          keyboardStepHandle(stepSide, dx, dy)
          return
        }
      }
      if (!state.kbSelected) return
      // 防误触第二闸：关节步进分支同样受 sceneBusy 保护（输入框打字期间冻结 W/S/Q/E/A/D）
      if (sceneBusy) return
      // 2026-08-31 修复：补上 Shift 大步档——此前只有 Ctrl 精细/常规两档，
      // kb-hud 与 HelpGuide 却写着 "Shift+W/S ±3°"（说明与实际不符，Shift 被静默忽略）。
      const fine = e.ctrlKey ? KB_FINE : (e.shiftKey ? KB_BIG : KB_STEP)
      const { side, index } = state.kbSelected
      let handled = true
      switch (e.key.toLowerCase()) {
        case 'w': jogJoint(side, index, +fine); break
        case 's': jogJoint(side, index, -fine); break
        case 'q': jogJoint(side, 1, +fine); break  // Q/E：同臂肩关节(J2)抬/降
        case 'e': jogJoint(side, 1, -fine); break
        case 'a': case 'tab': state.kbSelected = { side, index: (index + 6) % 7 }; break
        case 'd': state.kbSelected = { side, index: (index + 1) % 7 }; break
        case ' ': deps.options.onHomeRequest?.(side); break
        case 'escape': state.kbSelected = null; break  // Esc 取消选中（App 顶层已处理退出拖动/关面板）
        default: handled = false
      }
      if (handled) e.preventDefault()
    }

    // ═══ 场景级键盘防误触（2026-08-31 太阳系改造引入的回归风险防护）═══
    // 背景：键盘事件全局注册（window），用户可盲打控制机械臂；输入焦点一旦残留在任意
    // UI 输入框（帮助面板搜索框等），盲打 W/A/S/D 会同时驱动机械臂——场景越华丽用户越
    // 容易分心，风险越高。防护口径：焦点位于可编辑元素（input/textarea/select/
    // contenteditable）期间 sceneBusy=true，JS 侧 W/A/S/D 实际驱动矩阵直接短路冻结，
    // 物理侧另有 200ms 失联看门狗兜底；焦点回到页面（blur）立即恢复。中文输入法的
    // 数字选词/字母上屏只发生在 editable 焦点内，天然不受影响。
    const isEditableTarget = (el: Element | null): boolean => {
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable === true
    }
    let sceneBusy = false
    const updateSceneBusy = (): void => { sceneBusy = isEditableTarget(document.activeElement) }
    window.addEventListener('focusin', updateSceneBusy)
    window.addEventListener('focusout', updateSceneBusy)

    dom.addEventListener('pointerdown', onPointerDown)
    dom.addEventListener('pointermove', onPointerMove)
    dom.addEventListener('pointerup', onPointerUp)
    dom.addEventListener('pointercancel', onPointerUp)
    // 兜底（2026-08-30 用户第七轮#3）：极少数路径下 dom 的 pointerup 会因指针捕获
    // 异常丢失 → 拖动态残留（观感"松手后还在继续控制"）。window 捕获阶段再挂同一
    // 处理器：状态清理是幂等的（已清空时第二次调用是 no-op），任何丢事件路径都能收尾。
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    dom.addEventListener('wheel', onWheel, { passive: false })
    dom.addEventListener('dblclick', onDblClick)
    window.addEventListener('keydown', onKeyDown)
    // ══ 键盘 Jog 松开即停（2026-09-05）：keyup 移除按住键。
    //    窗口级监听：即使焦点短暂进入 iframe/子元素也能收到 keyup，防锁键。──
    const onKeyUp = (e: KeyboardEvent) => {
      // 🔴-2 修复（2026-09-05 QA-1）：keyup 只做「移除按键」的收尾动作，绝不驱动运动，
      // 不能因 sceneBusy 短路。否则序列「按住 W → 点击输入框(sceneBusy=true) → 松开 W」
      // 会让 keyup 被吞，pressed 残留 'w' → rAF 循环继续下发 → 松开后机械臂仍持续运动，
      // 违背「松开即停」安全要求。keydown 侧 sceneBusy 拦截不变（驱动入口仍被冻结）。
      keyboardJogOnKeyUp(e)
    }
    // 🔴-2 兜底（QA-1）：浏览器失焦（Alt+Tab/切窗口）清空全部 pressed 并停循环。
    // 失焦时窗口级键盘事件调度不可靠，可能漏收 keyup；残留按住键会让机械臂持续运动，
    // 失焦清空是「松开即停」之外的最后一道安全闸。走 jogClearAll 状态机导出，
    // 不在本文件直接读写 pressed 集合。
    const onWindowBlur = () => {
      jogClearAll(JOG)
      deps.onJogStateChange?.({ stepLevel: JOG.stepLevel, active: false })
      jogStopLoop()
    }
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onWindowBlur)
    deps.eventCleanup.push(() => {
      dom.removeEventListener('pointerdown', onPointerDown)
      dom.removeEventListener('pointermove', onPointerMove)
      dom.removeEventListener('pointerup', onPointerUp)
      dom.removeEventListener('pointercancel', onPointerUp)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      dom.removeEventListener('wheel', onWheel)
      dom.removeEventListener('dblclick', onDblClick)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onWindowBlur)   // 失焦兜底随场景卸载一并移除
      // 卸载时停止 Jog 循环（防止残余 rAF 空转泄漏）
      jogStopLoop()
      // 场景级键盘防误触的焦点监听器随场景卸载一并移除（防跨组件泄漏）
      window.removeEventListener('focusin', updateSceneBusy)
      window.removeEventListener('focusout', updateSceneBusy)
    })
  }
