<script setup lang="ts">
/**
 * @file    ChassisStrip.vue
 * @brief   底部底盘信息条（无卡片纯文本）：行走1~4 / 转向1~4 / 升降 三组 9 电机明细
 *          每电机一行：编码器位置 · 速度 · 电流 · 状态码 · 错误码
 * @author Csihan
 * @date    2026-08-28
 *
 * 2026-09-05（UI 专项审查）：
 *   - B1 修复：行走电机位置列此前直接 `m.encoder.toFixed(1)°`（角度口径），与
 *     组标题「位置=pulse」及 enc() 口径矛盾——模板已统一改走 enc(m)；
 *   - I1：三组标题（行走/转向/升降）视觉层级强化（字号+1/更亮/底部细分隔线），
 *     扫视一眼分三组（Foxglove 风格）；
 *   - I2：位置/速度列全部收敛到 utils/chassisUnits.ts 统一换算函数，无组件自换算。
 */
import type { ChassisStatus, MotorElectric } from '../types/robot'
import { toRpm, toWheelPulse } from '../utils/chassisUnits'

const props = defineProps<{ chassis: ChassisStatus; active?: boolean }>()

// 位置列：按用户口径（2026-08-29）——行走=pulse、转向/弯腰=°、升降=mm
// 2026-09-05：行走电机模板也统一改走本函数（此前模板里直接 toFixed° 显示角度，是 B1 口径 bug）
function enc(m: MotorElectric): string {
  if (m.name === 'lift_motor') return `${m.encoder.toFixed(0)}mm`
  if (m.name.startsWith('wheel_')) return `${toWheelPulse(m.encoder)} pulse`
  return `${m.encoder.toFixed(1)}°`
}
// 速度列：统一 RPM（Mock 仿真域 ÷6 折算，见 chassisUnits.ts 文件头）
function vel(m: MotorElectric): string {
  return `${toRpm(m.velocity).toFixed(1)} RPM`
}
// 电机是否有故障（错误码/状态码任一非零）
function hasFault(m: MotorElectric | null): boolean {
  return !!m && (m.errorCode !== 0 || m.statusCode !== 0)
}
// 状态列：正常 / S码 / E码（合并显示）
function stat(m: MotorElectric): string {
  if (m.errorCode !== 0) return `E${m.errorCode}`
  if (m.statusCode !== 0) return `S${m.statusCode}`
  return '正常'
}
</script>

<template>
  <div class="chassis-strip" :class="{ active }">
    <!-- 行走电机 1~4：位置=编码器脉冲（pulse） -->
    <div class="cg">
      <div class="cg-title">行走电机 <small class="cg-sub">位置=pulse</small></div>
      <div class="mrow" v-for="(m, i) in chassis.wheels" :key="m.name"
           :class="{ err: hasFault(m) }">
        <span class="mn">{{ i + 1 }}</span>
        <!-- 2026-09-05（B1 修复）：此列必须走 enc(m)（=pulse 口径），与标题「位置=pulse」一致；
             原模板直接 toFixed(1)° 是角度口径残留 bug（审查发现）。 -->
        <span class="mv">{{ enc(m) }}</span>
        <span class="mv">{{ vel(m) }}</span>
        <span class="mv">{{ m.current.toFixed(2) }}A</span>
        <span class="mv" :class="hasFault(m) ? 'err' : 'ok'">{{ stat(m) }}</span>
      </div>
    </div>
    <!-- 转向电机 1~4：位置=转向角度 -->
    <div class="cg">
      <div class="cg-title">转向电机 <small class="cg-sub">位置=角度</small></div>
      <div class="mrow" v-for="(m, i) in chassis.steers" :key="m.name"
           :class="{ err: hasFault(m) }">
        <span class="mn">{{ i + 1 }}</span>
        <!-- 2026-09-05（I2）：转向/弯腰也走 enc(m)（=°口径），与升降/行走同一换算函数 -->
        <span class="mv">{{ enc(m) }}</span>
        <span class="mv">{{ vel(m) }}</span>
        <span class="mv">{{ m.current.toFixed(2) }}A</span>
        <span class="mv" :class="hasFault(m) ? 'err' : 'ok'">{{ stat(m) }}</span>
      </div>
    </div>
    <!-- 升降电机：位置=行程 mm -->
    <div class="cg">
      <div class="cg-title">升降电机 <small class="cg-sub">位置=行程</small></div>
      <div class="mrow" v-if="chassis.lift" :class="{ err: hasFault(chassis.lift) }">
        <span class="mn">Z</span>
        <span class="mv">{{ enc(chassis.lift) }}</span>
        <span class="mv">{{ vel(chassis.lift) }}</span>
        <span class="mv">{{ chassis.lift.current.toFixed(2) }}A</span>
        <span class="mv" :class="hasFault(chassis.lift) ? 'err' : 'ok'">{{ stat(chassis.lift) }}</span>
      </div>
      <!-- 弯腰电机（2026-08-29 新增）：位置=角度，速度统一 RPM 口径 -->
      <div class="mrow" v-if="chassis.bend" :class="{ err: hasFault(chassis.bend) }">
        <span class="mn">B</span>
        <span class="mv">{{ enc(chassis.bend) }}</span>
        <span class="mv">{{ vel(chassis.bend) }}</span>
        <span class="mv">{{ chassis.bend.current.toFixed(2) }}A</span>
        <span class="mv" :class="hasFault(chassis.bend) ? 'err' : 'ok'">{{ stat(chassis.bend) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 2026-08-29 重排：侧栏底边已抬高到 272px，底盘条独占底部走廊，纵向不再与爪面板冲突。
   宽度三个自由度（列宽/列间距/字号）全部 clamp 自适应，保证窄窗口不超出屏幕边缘。 */
.chassis-strip { position:absolute; bottom:96px; left:50%; transform:translateX(-50%);
  display:flex; gap:clamp(14px, 1.9vw, 44px); z-index:5; pointer-events:auto;
  background:var(--hud-tint); border-radius:8px; padding:8px clamp(12px, 1.4vw, 26px);
  transition:opacity .3s; max-width:calc(100vw - 16px); }
.focus-mode .chassis-strip { opacity:.15; pointer-events:none; }
/* 2026-09-05（I1）：三组标题视觉层级强化——字号在 --fs-title 基础上 +1、更亮、
   底部细分隔线，扫视一眼分三组（行走/转向/升降），对齐 Foxglove 状态分组风格 */
.cg-title { font-size:calc(var(--fs-title) + 1px); font-weight:700; color:#fff;
  letter-spacing:2px; margin-bottom:3px; white-space:nowrap;
  border-bottom:1px solid rgba(46,230,214,.18); padding-bottom:2px; }
.cg-sub { font-size:var(--fs-cap); color:var(--acc); font-weight:500; letter-spacing:0; }
.mrow { display:flex; gap:clamp(5px, 0.6vw, 12px); font-size:var(--fs-row);
  line-height:1.4; font-family:var(--m); white-space:nowrap; }
.mn { color:var(--acc); width:clamp(16px, 1.5vw, 30px); text-align:right; }
.mv { color:var(--tx); min-width:clamp(58px, 6vw, 118px); }
.mv.dim { color:var(--dim); }
.mv.ok { color:var(--grn); }
.mv.err, .mrow.err .mv { color:var(--red); }
</style>
