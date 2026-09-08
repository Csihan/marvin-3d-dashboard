<script setup lang="ts">
/**
 * @file    StatusDock.vue
 * @brief   右下紧凑底盘/头部状态坞：正常收缩，悬停展开明细
 * @author Csihan
 * @date    2026-08-29
 *
 * 组件职责：
 *   右下角常驻的紧凑状态坞，正常态只显示摘要行（头部/行走/转向/升降）；
 *   展开 <details> 后显示全部电机明细（位置/速度/电流/错误码）。
 *
 * 交互：
 *   - 默认收起，用户点击「电机明细」标题展开；
 *   - 电机有故障时行变红（err class）。
 *
 * 2026-09-05（UI 专项审查）：
 *   - B1：行走摘要行此前 `${m.encoder.toFixed(0)}°`（角度口径）与底条矛盾——
 *     已改走 toWheelPulse（=pulse 口径）；
 *   - I2：明细速度列改走 toRpm（RPM 口径），位置/速度口径全部收敛到 chassisUnits.ts。
 */
import StatusText from './StatusText.vue'
import type { ChassisStatus, HeadStatus, MotorElectric } from '../types/robot'
import { toRpm, toWheelPulse } from '../utils/chassisUnits'

/**
 * Props 定义。
 * @prop chassis - 底盘整体状态（4 行走 + 4 转向 + 升降 + 弯腰）
 * @prop head    - 头部状态（yaw/pitch 角度 + 电流 + 错误码）
 */
defineProps<{ chassis: ChassisStatus; head: HeadStatus }>()

/**
 * 电机位置明细文本：与 ChassisStrip/ChassisPanel 同口径
 * （行走=pulse、转向/弯腰=°、升降=mm）。
 * @param m - 电机明细对象
 * @returns 带单位的显示文本
 */
function enc(m: MotorElectric): string {
  if (m.name === 'lift_motor') return `${m.encoder.toFixed(0)}mm`
  if (m.name.startsWith('wheel_')) return `${toWheelPulse(m.encoder)} pulse`
  return `${m.encoder.toFixed(1)}°`
}

/**
 * 判断电机是否有故障（错误码或状态码任一非零）。
 * @param m - 电机明细对象（null 安全）
 * @returns true 表示存在故障
 */
function fault(m: MotorElectric | null): boolean {
  return !!m && (m.errorCode !== 0 || m.statusCode !== 0)
}
</script>

<template>
  <section class="status-dock">
    <!-- 标题栏 -->
    <div class="dock-head">SYSTEM</div>
    <!-- 摘要行：头部/行走/转向/升降 各一行 StatusText -->
    <div class="rows">
      <!-- 头部摘要：左右摇头角度 / 上下点头角度 -->
      <StatusText k="头部" :v="`${head.yaw.toFixed(0)}° / ${head.pitch.toFixed(0)}°`"
                  :tone="head.yawReached && head.pitchReached ? 'ok' : 'warn'" />
      <!-- 行走电机摘要：4 个行走电机位置（pulse，2026-09-05 B1 修复：与底条口径统一，
           删除此前的角度展示 toFixed(0)° 残留） -->
      <StatusText k="行走" :v="`${chassis.wheels.map(m => toWheelPulse(m.encoder)).join(' ')} pulse`" tone="dim" />
      <!-- 转向电机摘要：4 个转向电机位置（角度）-->
      <StatusText k="转向" :v="chassis.steers.map(m => `${m.encoder.toFixed(0)}°`).join(' ')" tone="dim" />
      <!-- 升降电机摘要：绝对高度（mm） -->
      <StatusText k="升降" :v="`${chassis.lift?.encoder.toFixed(0) ?? '--'}mm`" tone="ok" />
    </div>
    <!-- 可展开的电机明细表：点击「电机明细」标题展开/收起 -->
    <details>
      <summary>电机明细</summary>
      <div class="matrix">
        <!-- 遍历行走4 + 转向4 + 升降，每电机一行：name/位置/速度/电流/错误码
             位置/速度口径收敛到 chassisUnits.ts（2026-09-05 I2） -->
        <div v-for="m in [...chassis.wheels, ...chassis.steers, chassis.lift].filter(Boolean)"
             :key="m!.name" class="motor" :class="{ err: fault(m) }">
          <b>{{ m!.name }}</b>
          <span>{{ enc(m!) }}</span>
          <span>{{ toRpm(m!.velocity).toFixed(1) }}rpm</span>
          <span>{{ m!.current.toFixed(2) }}A</span>
          <span>E{{ m!.errorCode }}</span>
        </div>
      </div>
    </details>
  </section>
</template>
