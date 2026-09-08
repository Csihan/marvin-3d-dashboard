/**
 * @file    labels.ts
 * @brief   URDF 关键 link 的 CSS2D 浮动标签系统（臂角度/爪开度/轮/转向/头/躯干/升降）
 * @author Csihan
 * @date    2026-09-01
 *
 * 设计（P3 交互拆分，2026-09-01）：
 *   - 从 useRobot3D.ts 剥离 makeLabel/attachLabels/refreshLabels 及标签容器状态，
 *     收敛为 createRobotLabels 工厂，暴露最小接口 { attach, refresh }；
 *   - 依赖注入：robot（URDF 模型，getObjectByName 查 link）+ jointPositions（关节值 ref）
 *     + allLabels（DOM 注册表，供 useRobot3D 卸载时统一 remove 含 hover 标签）；
 *   - 行为「原样迁移」，不重写任何标签挂载/刷新逻辑。
 */

import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Ref } from 'vue'

/** 标签系统控制器：模型加载后 attach，每帧/每状态更新后 refresh。 */
export interface RobotLabels {
  /** 给关键 link 挂 CSS2D 标签（模型加载完成后调用一次）。 */
  attach(): void
  /** 刷新标签文字：臂角度（rad→deg）与爪开度（m→%）、轮/转向位置。 */
  refresh(): void
}

/** createRobotLabels 依赖注入参数。 */
export interface RobotLabelsDeps {
  /** URDF 模型对象（含 getObjectByName 查找 link 节点）。 */
  robot: any
  /** 关节值 ref（name → rad/m），标签文字的数据源。 */
  jointPositions: Ref<Record<string, number>>
  /** DOM 注册表（useRobot3D 持有的全部标签元素，含 hover 标签，卸载时统一 remove）。 */
  allLabels: HTMLElement[]
}

/**
 * 创建机器人标签系统（原 useRobot3D.ts 1707~1808 行原样迁移）。
 * @param deps robot / jointPositions / allLabels 依赖注入
 */
export function createRobotLabels(deps: RobotLabelsDeps): RobotLabels {
  const { robot, jointPositions, allLabels } = deps
  const labelObjs: CSS2DObject[] = []

  function makeLabel(text: string, cls: string): HTMLElement {
    const el = document.createElement('div')
    el.className = `hud-tag ${cls}`
    el.textContent = text
    allLabels.push(el)
    return el
  }

  /** 给关键 link 挂 CSS2D 标签（通过 link 名精确查找节点） */
  function attach(name: string, el: HTMLElement, yOff: number): void {
    const link = robot.getObjectByName(name)
    if (!link) return
    const obj = new CSS2DObject(el)
    obj.position.set(0, yOff, 0)
    link.add(obj)
    labelObjs.push(obj)
  }

  function attachLabels(): void {
    // 双臂：7-DOF 腕部末端 Link7 挂角度标签（每帧由 refreshLabels 更新文字）。
    // URDF 实际 link 名为 Link1~Link7，此前误写 Wrist6 导致标签从未挂上（2026-08-30 修正）。
    const elAL = makeLabel('左臂 --°', 'arm')
    elAL.dataset.side = 'L'
    attach('Link7_L', elAL, 0.12)
    const elAR = makeLabel('右臂 --°', 'arm')
    elAR.dataset.side = 'R'
    attach('Link7_R', elAR, 0.12)
    // 双爪：开度（挂在夹爪指尖 link 上）
    const elGL = makeLabel('左爪 0%', 'grip')
    elGL.dataset.side = 'L'
    const elGR = makeLabel('右爪 0%', 'grip')
    elGR.dataset.side = 'R'
    attach('gripper_L_finger_link', elGL, 0.06)
    attach('gripper_R_finger_link', elGR, 0.06)
    // 头部
    attach('head_yaw_link', makeLabel('头部', 'head'), 0.1)
    // 躯干
    attach('torso_lift_link', makeLabel('躯干', 'torso'), 0.2)
    // 底盘：4 轮 + 4 转向（低调样式，不喧宾）。用 data-* 记录关节名与类型，
    // refreshLabels 直接读取，避免从"轮1"这类显示文字脆性地反推关节名。
    const wheelLinks: Array<[string, string]> = [
      ['front_left_wheel_link', 'front_left_wheel_joint'],
      ['front_right_wheel_link', 'front_right_wheel_joint'],
      ['rear_left_wheel_link', 'rear_left_wheel_joint'],
      ['rear_right_wheel_link', 'rear_right_wheel_joint'],
    ]
    wheelLinks.forEach(([link, joint], i) => {
      const el = makeLabel(`轮${i + 1}`, 'chassis')
      el.dataset.joint = joint
      el.dataset.kind = 'wheel'
      el.dataset.label = `轮${i + 1}`
      attach(link, el, 0.05)
    })
    const steerLinks: Array<[string, string]> = [
      ['front_left_steer_link', 'front_left_steer_joint'],
      ['front_right_steer_link', 'front_right_steer_joint'],
      ['rear_left_steer_link', 'rear_left_steer_joint'],
      ['rear_right_steer_link', 'rear_right_steer_joint'],
    ]
    steerLinks.forEach(([link, joint], i) => {
      const el = makeLabel(`转向${i + 1}`, 'chassis')
      el.dataset.joint = joint
      el.dataset.kind = 'steer'
      el.dataset.label = `转向${i + 1}`
      attach(link, el, 0.09)
    })
    // 升降（静态标签，标记升降柱；与"躯干"共用 torso_lift_link，用负偏移错开位置）
    attach('torso_lift_link', makeLabel('升降', 'chassis'), -0.15)
  }

  /** 每帧刷新标签文字：臂角度（rad→deg）与爪开度（m→%） */
  function refreshLabels(): void {
    const deg = (r: number | undefined) => r === undefined ? '--' : (r * 180 / Math.PI).toFixed(1)
    labelObjs.forEach(o => {
      const el = o.element as HTMLElement
      if (el.classList.contains('arm')) {
        const side = el.dataset.side === 'R' ? 'R' : 'L'
        let sum = 0
        for (let j = 1; j <= 7; j++) sum += jointPositions.value[`Joint${j}_${side}`] ?? 0
        el.textContent = `${side === 'L' ? '左臂' : '右臂'} J1~7 Σ${deg(sum / 7)}°`
      } else if (el.classList.contains('grip')) {
        const side = el.dataset.side === 'R' ? 'R' : 'L'
        const v = jointPositions.value[side === 'L' ? 'gripper_L_joint' : 'gripper_R_joint'] ?? 0
        el.textContent = `${side === 'L' ? '左爪' : '右爪'} ${Math.round(v * 1000 / 60 * 100)}%`
      } else if (el.classList.contains('chassis')) {
        // 只刷新带 data-joint 的轮/转向标签；"升降"是静态标签（无 data-joint）直接跳过。
        const joint = el.dataset.joint
        if (!joint) return
        const v = jointPositions.value[joint]
        el.textContent = el.dataset.kind === 'wheel'
          ? `${el.dataset.label ?? ''} ${(v ?? 0).toFixed(2)}`
          : `${el.dataset.label ?? ''} ${deg(v)}°`
      }
    })
  }

  return { attach: attachLabels, refresh: refreshLabels }
}
