/**
 * @file    jogCartesian.ts
 * @brief   示教模式键盘笛卡尔飞控 (Jog) 状态机：六轴增量 + 步长档位 + 按住持续
 * @author Csihan
 * @date    2026-09-05
 *
 * 设计动机（2026-09-05 任务 TEACH-KEYBOARD-JOG-20260905，替代 3D 鼠标拖拽）：
 *   3D 鼠标拖拽难以感知"深度"，用户希望进入示教模式后纯键盘即可控制选中臂 tool0：
 *     - W/S：沿相机视线方向 前/后（推进/撤出，+X/-X 语义，方向向量由调用方注入）
 *     - A/D：机器人左右 横移（+Y/-Y，世界轴）
 *     - R/F：竖直 上升/下降（+Z/-Z）
 *     - Q/E：末端偏航旋转（Yaw，绕世界 Z）
 *     - Z/X：末端俯仰旋转（Pitch，绕世界 Y）
 *     - 1/2/3：切换步长（精调 2mm/0.5°、常规 10mm/2°、大步 30mm/5°）
 *
 * 模块职责边界：
 *   1. 纯输入状态机——不直接触碰 Three.js/DOM/rosbridge，只维护
 *      「当前按住的轴集合 + 步长档位 + 单命令间隔」三件事，输出为
 *      "下一次 6D 目标增量"，由调用方（scene/drag.ts）负责 IK 解算与下发。
 *      拆出独立模块的原因：按住持续逻辑（keydown 启 / keyup 停 /
 *      多键同时按住累加）可被 vitest 纯函数单测，不依赖渲染环境。
 *   2. 步长档位语义：1/2/3 三档，平移 mm / 旋转 ° 成对定义，
 *      HUD 显示档位名，见 JOG_STEPS。
 *
 * 安全约定：
 *   - 本模块不判断"是否允许驱动"（sceneBusy / 未进入示教 等由 drag.ts
 *     在键盘分发处统一拦截），模块只负责按键存在时的机械增量换算。
 *   - 命令节流：JogLoop 内部按 minIntervalMs 丢弃过快帧，避免刷爆 rosbridge。
 */

/** 六轴动作标识：t=平移(X/Y/Z) r=旋转(Yaw/Pitch) */
export type JogAxis = 'tx' | 'ty' | 'tz' | 'ry' | 'rp'

/** 步长档位枚举（1/2/3 快捷键对应） */
export type JogStepLevel = 1 | 2 | 3

/** 步长档位定义：平移 mm/次，旋转 °/次（用户口径精确值） */
export interface JogStepConfig {
  level: JogStepLevel
  /** HUD 展示名 */
  label: string
  /** 单帧平移步长（米，世界单位） */
  translateM: number
  /** 单帧旋转步长（弧度） */
  rotateRad: number
}

/** 内置三档步长（2026-09-05 用户口径：精调 2mm/0.5°、常规 10mm/2°、大步 30mm/5°） */
export const JOG_STEPS: Record<JogStepLevel, JogStepConfig> = {
  1: { level: 1, label: '精调 2mm / 0.5°', translateM: 0.002, rotateRad: 0.5 * Math.PI / 180 },
  2: { level: 2, label: '常规 10mm / 2°', translateM: 0.010, rotateRad: 2 * Math.PI / 180 },
  3: { level: 3, label: '大步 30mm / 5°', translateM: 0.030, rotateRad: 5 * Math.PI / 180 },
}

/** 单个动作键的细粒度映射（供 drag.ts 组装当前帧增量）：
 *  一组按键可以映射为「平移增量(m)」或「旋转增量(rad)」，二者取一。
 *  返回 null 表示该键不参与 Jog。 */
export type JogKeyMap = Record<string, {
  /** 该键对应的动作轴 */
  axis: JogAxis
  /** 方向符号：+1 / -1 */
  sign: 1 | -1
}>

/**
 * 按住持续 Jog 循环状态（keydown 启动 / keyup 停止）。
 * 设计为"寄存器"式：任何时刻按下任意方向键都直接累加到 pressed 集合，
 * 循环每帧把 pressed 里每个轴的增量累加一次；keyup 移除对应键。
 */
export interface JogLoopState {
  /** 当前被按住的键集合（保存 e.code / key 原文，用于 keyup 精确移除） */
  pressed: Set<string>
  /** 当前档位 */
  stepLevel: JogStepLevel
  /** 上一帧时间戳（性能节流用） */
  lastTickAt: number
  /** 目标位姿累计（m + 弧度四元数角度增量）——由调用方决定存什么 */
  target: JogTarget
}

/** Jog 目标累计：平移为世界矢量位移；旋转为从初始姿态累计的 Euler 增量。
 *  调用方把 target 转成 IK 输入（位置 + 四元数）。 */
export interface JogTarget {
  /** 世界坐标系累计位移（米） */
  translate: { x: number; y: number; z: number }
  /** 累计偏航角（rad，绕世界 Z） */
  yaw: number
  /** 累计俯仰角（rad，绕世界 Y） */
  pitch: number
}

/** 创建初始 Jog 目标（零位移、零旋转） */
export function createJogTarget(): JogTarget {
  return { translate: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }
}

/** 创建初始循环状态（默认常规档、无按住键） */
export function createJogLoop(): JogLoopState {
  return {
    pressed: new Set<string>(),
    stepLevel: 2,
    lastTickAt: 0,
    target: createJogTarget(),
  }
}

/** 查询当前档位配置 */
export function jogStepConfig(level: JogStepLevel): JogStepConfig {
  return JOG_STEPS[level]
}

/** 切换档位（钳制在 1..3；返回新档位供 HUD 显示） */
export function setJogStepLevel(s: JogLoopState, level: number): JogStepLevel {
  const clamped = Math.min(3, Math.max(1, Math.trunc(level))) as JogStepLevel
  s.stepLevel = clamped
  return clamped
}

/** 记录一个按键为"按住"（幂等：重复 keydown 不叠加） */
export function jogKeyDown(s: JogLoopState, key: string): void {
  s.pressed.add(key)
}

/** 记录一个按键为"松开"（幂等） */
export function jogKeyUp(s: JogLoopState, key: string): void {
  s.pressed.delete(key)
}

/**
 * 清空全部按住键（失焦兜底/紧急停止用）。
 * 防锁键的最后一道安全闸（2026-09-05 QA-1 🔴-2）：浏览器失焦（Alt+Tab/切窗口）等
 * 路径可能收不到 keyup，若 pressed 残留会让上层 rAF 循环持续下发命令、机械臂不停。
 * 调用方应在清理后立即同步上报 active=false 并停止循环；drag.ts 不直接读写 pressed
 * 集合（状态机的输出必须经由本文件导出函数，保证多入口一致性）。
 */
export function jogClearAll(s: JogLoopState): void {
  s.pressed.clear()
}

/** 当前是否有任何键按住（供调用方决定是否继续循环） */
export function jogActive(s: JogLoopState): boolean {
  return s.pressed.size > 0
}

/**
 * 按当前档位把一个按键映射为单帧目标增量：先查询 keyMap 得到轴与方向，
 * 再按档位配置换算；平移/旋转分别累加到 target。
 *
 * ⚠ 语义要点（2026-09-05 修正）：只有「当前仍按住的键」（s.pressed 中存在）
 * 才累加——否则 keyup 后外部循环若仍以旧键调本函数，目标会继续漂移，
 * 违反"松开即停"需求。pressed 集合是累加的唯一闸门。
 *
 * @param keyMap  键 → {axis, sign} 映射（由 drag.ts 按"相机视线/世界轴"语义构造）
 * @param key     当前按住的键
 * @param s       循环状态（就地累加 target）
 * @returns       是否真正发生了累加（按键未按住或不在映射内返回 false）
 */
export function jogApplyKey(s: JogLoopState, keyMap: JogKeyMap, key: string): boolean {
  if (!s.pressed.has(key)) return false
  const cfg = JOG_STEPS[s.stepLevel]
  const map = keyMap[key]
  if (!map) return false
  const step = map.sign
  switch (map.axis) {
    case 'tx': s.target.translate.x += step * cfg.translateM; break
    case 'ty': s.target.translate.y += step * cfg.translateM; break
    case 'tz': s.target.translate.z += step * cfg.translateM; break
    case 'ry': s.target.yaw += step * cfg.rotateRad; break
    case 'rp': s.target.pitch += step * cfg.rotateRad; break
  }
  return true
}

/**
 * 节流判定：距上一帧不足 minIntervalMs 时返回 true（应跳过本帧）。
 * 与 drag.ts sendArmCommand 的 33ms 节流口径保持一致（约 30Hz）。
 */
export function jogThrottled(s: JogLoopState, now: number, minIntervalMs = 33): boolean {
  if (now - s.lastTickAt < minIntervalMs) return true
  s.lastTickAt = now
  return false
}
