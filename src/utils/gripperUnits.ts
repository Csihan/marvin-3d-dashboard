/**
 * @file    gripperUnits.ts
 * @brief   夹爪单位与常量单一事实源（PGC-300-60 实测口径，2026-08-31）
 * @author Csihan
 * @date    2026-08-31
 *
 * 语义口径（用户确认，2026-08-31）：
 *   PGC-300-60 = 最大夹持力 300N / 全行程开口 60mm；
 *   开口 = 两指张开的开口距离：60mm=张开、0mm=两指闭合合拢。
 *   ROS 层 position（米）即开口距离，与本口径一致；此前 Web 分散的
 *   0.06 / 60 / ÷3 魔法数统一收编到这里。
 */

/** 全行程开口：60mm（张满=两指张开到最大开口） */
export const STROKE_M = 0.06
export const STROKE_MM = 60
/** 最大夹持力：300N（力度滑杆 100% 对应的物理力） */
export const MAX_FORCE_N = 300

/** 开口米 → 毫米 */
export function mToMm(m: number): number {
  return m * 1000
}
/** 开口米 → 百分比（0=闭合 / 100=张满 60mm） */
export function mToPct(m: number): number {
  return (m / STROKE_M) * 100
}
/** 百分比 → 开口米 */
export function pctToM(pct: number): number {
  return (pct / 100) * STROKE_M
}
/** 力度百分比 → 牛顿（100% = 300N） */
export function pctToNewton(pct: number): number {
  return (pct / 100) * MAX_FORCE_N
}