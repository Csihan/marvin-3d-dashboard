/**
 * @file    jogCartesian.test.ts
 * @brief   键盘笛卡尔 Jog 状态机单测：步长档位 / 按住累加 / 松开停止 / 节流
 * @author Csihan
 * @date    2026-09-05
 *
 * 覆盖点（对应需求验收）：
 *   1. 三档步长数值精确（2mm/0.5°、10mm/2°、30mm/5°）；
 *   2. 按住 = 每帧累加，松开 = 停止累加（pressed 集合移除）；
 *   3. 档位切换边界钳制（1..3）；
 *   4. 节流：不足 minIntervalMs 帧被丢弃（命令频率上限）。
 */
import { describe, it, expect } from 'vitest'
import {
  createJogLoop, createJogTarget, jogKeyDown, jogKeyUp, jogActive, jogApplyKey,
  setJogStepLevel, jogStepConfig, jogThrottled, jogClearAll, type JogKeyMap,
} from '../jogCartesian'

/** 测试用键映射：w=前(+tx) s=后(-tx) a=左(-ty) d=右(+ty) r=上(+tz) f=下(-tz)
 *  q=偏航+ e=偏航- z=俯仰+ x=俯仰-（与真实键盘语义一致） */
const TEST_KEYMAP: JogKeyMap = {
  w: { axis: 'tx', sign: 1 },
  s: { axis: 'tx', sign: -1 },
  a: { axis: 'ty', sign: -1 },
  d: { axis: 'ty', sign: 1 },
  r: { axis: 'tz', sign: 1 },
  f: { axis: 'tz', sign: -1 },
  q: { axis: 'ry', sign: 1 },
  e: { axis: 'ry', sign: -1 },
  z: { axis: 'rp', sign: 1 },
  x: { axis: 'rp', sign: -1 },
}

describe('Jog 步长档位', () => {
  it('三档数值与用户口径一致（平移 mm / 旋转 °）', () => {
    const s1 = jogStepConfig(1)
    expect(s1.translateM).toBeCloseTo(0.002, 6)                    // 精调 2mm
    expect(s1.rotateRad).toBeCloseTo(0.5 * Math.PI / 180, 9)       // 0.5°
    const s2 = jogStepConfig(2)
    expect(s2.translateM).toBeCloseTo(0.010, 6)                    // 常规 10mm
    expect(s2.rotateRad).toBeCloseTo(2 * Math.PI / 180, 9)         // 2°
    const s3 = jogStepConfig(3)
    expect(s3.translateM).toBeCloseTo(0.030, 6)                    // 大步 30mm
    expect(s3.rotateRad).toBeCloseTo(5 * Math.PI / 180, 9)         // 5°
  })

  it('档位切换钳制在 1..3', () => {
    const s = createJogLoop()
    expect(setJogStepLevel(s, 1)).toBe(1)
    expect(setJogStepLevel(s, 3)).toBe(3)
    expect(setJogStepLevel(s, 0)).toBe(1)   // 下溢出钳到 1
    expect(setJogStepLevel(s, 9)).toBe(3)   // 上溢出钳到 3
    expect(setJogStepLevel(s, 2.7)).toBe(2) // 非整数截断
  })
})

describe('按住持续累加 / 松开即停', () => {
  it('按下一键并逐帧累加：每帧按档位增量', () => {
    const s = createJogLoop()
    setJogStepLevel(s, 3)                    // 大步档：30mm/帧
    jogKeyDown(s, 'w')
    expect(jogActive(s)).toBe(true)
    expect(jogApplyKey(s, TEST_KEYMAP, 'w')).toBe(true)
    expect(s.target.translate.x).toBeCloseTo(0.030, 6)
    expect(jogApplyKey(s, TEST_KEYMAP, 'w')).toBe(true)
    expect(s.target.translate.x).toBeCloseTo(0.060, 6)   // 第二帧继续累加
  })

  it('同轴反向键累加抵消（按 w 又按 s）', () => {
    const s = createJogLoop()
    setJogStepLevel(s, 2)
    jogKeyDown(s, 'w'); jogKeyDown(s, 's')
    jogApplyKey(s, TEST_KEYMAP, 'w'); jogApplyKey(s, TEST_KEYMAP, 's')
    expect(s.target.translate.x).toBeCloseTo(0, 9)
  })

  it('松开该键后不再累加（pressed 移除）', () => {
    const s = createJogLoop()
    setJogStepLevel(s, 1)
    jogKeyDown(s, 'd')
    jogApplyKey(s, TEST_KEYMAP, 'd')
    jogKeyUp(s, 'd')
    expect(jogActive(s)).toBe(false)
    const before = s.target.translate.y
    jogApplyKey(s, TEST_KEYMAP, 'd')   // keyup 后不应累加
    expect(s.target.translate.y).toBeCloseTo(before, 9)
  })

  it('旋转轴累加弧度并保持单位正确', () => {
    const s = createJogLoop()
    setJogStepLevel(s, 1)                    // 0.5°/帧
    jogKeyDown(s, 'q'); jogKeyDown(s, 'z')
    jogApplyKey(s, TEST_KEYMAP, 'q')
    jogApplyKey(s, TEST_KEYMAP, 'z')
    expect(s.target.yaw).toBeCloseTo(0.5 * Math.PI / 180, 9)
    expect(s.target.pitch).toBeCloseTo(0.5 * Math.PI / 180, 9)
  })
})

describe('节流与多键', () => {
  it('不足 minIntervalMs 的帧被丢弃（30Hz 上限）', () => {
    const s = createJogLoop()
    s.lastTickAt = 1000
    expect(jogThrottled(s, 1010, 33)).toBe(true)    // 10ms 间隔 → 丢弃
    expect(jogThrottled(s, 1040, 33)).toBe(false)   // 40ms 间隔 → 放行并更新时间戳
    expect(jogThrottled(s, 1050, 33)).toBe(true)    // 紧随其后的 10ms 又丢弃
  })

  it('createJogTarget 返回零初始状态', () => {
    const t = createJogTarget()
    expect(t.translate).toEqual({ x: 0, y: 0, z: 0 })
    expect(t.yaw).toBe(0)
    expect(t.pitch).toBe(0)
  })
})

describe('失焦兜底紧停（jogClearAll，QA-1 🔴-2）', () => {
  it('清空全部按住键后 jogActive 立即为 false（防锁键）', () => {
    const s = createJogLoop()
    setJogStepLevel(s, 3)
    jogKeyDown(s, 'w'); jogKeyDown(s, 'a'); jogKeyDown(s, 'q')
    expect(jogActive(s)).toBe(true)
    jogClearAll(s)
    expect(jogActive(s)).toBe(false)
    expect(s.pressed.size).toBe(0)
    // 清空后按残留键不得再累加（若上层循环仍持旧键调用 jogApplyKey 也无效果）
    const beforeX = s.target.translate.x
    jogApplyKey(s, TEST_KEYMAP, 'w')
    expect(s.target.translate.x).toBe(beforeX)
  })

  it('空集合上 jogClearAll 幂等（多次/未激活调用无副作用）', () => {
    const s = createJogLoop()
    jogClearAll(s)
    jogClearAll(s)
    expect(jogActive(s)).toBe(false)
  })
})
