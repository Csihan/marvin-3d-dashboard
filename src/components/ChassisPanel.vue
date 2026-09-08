<script setup lang="ts">
/**
 * @file    ChassisPanel.vue
 * @brief   底盘控制面板（点击 3D 底盘弹出）：行走/转向只读明细 + 升降/弯腰控制
 * @author Csihan
 * @date    2026-08-29
 *
 * 单位口径（用户冻结）：速度统一 RPM；行走位置=pulse；转向=°；升降=mm
 * （真机行程 903.3~1453.3 绝对高度）；弯腰=°（URDF ±90° 限位）。
 * 控制链路：
 *   - 升降 → human_extern_cmd{platform_control:{z}}（m，comms 只下发 z 轴）；
 *   - 弯腰 → human_extern_cmd{motor_control:[{motor_type:2,target_angle:deg}]}
 *     （motor_type=2 → comms "torso" → motor_driver 弯腰模块）。
 * 安全：目标值在本组件与 App 层双重钳位；命令经 SIMULATION_ONLY 门禁。
 */
import { ref, watch } from 'vue'
import type { ChassisStatus, MotorElectric } from '../types/robot'
import { toRpm, toWheelPulse, LIFT_MIN_MM, LIFT_MAX_MM, BEND_MIN_DEG, BEND_MAX_DEG } from '../utils/chassisUnits'

const props = defineProps<{ chassis: ChassisStatus; busy?: boolean }>()
const emit = defineEmits<{ 'lift-to': [mm: number]; 'bend-to': [deg: number] }>()

// 目标值输入态：未交互时**持续跟随反馈**（修复"滑条/数字停在 0 不更新"，用户第八轮）；
// 用户交互后 dirty 锁定 1.5s（防反馈刷新打断拖动），随后恢复跟随。
const liftTarget = ref(LIFT_MIN_MM)
const bendTarget = ref(0)
const liftDirty = ref(false)
const bendDirty = ref(false)
let liftDirtyTimer: ReturnType<typeof setTimeout> | null = null
let bendDirtyTimer: ReturnType<typeof setTimeout> | null = null
function markLiftDirty(ms = 1500): void {
  liftDirty.value = true
  if (liftDirtyTimer) clearTimeout(liftDirtyTimer)
  liftDirtyTimer = setTimeout(() => { liftDirty.value = false }, ms)
}
function markBendDirty(ms = 1500): void {
  bendDirty.value = true
  if (bendDirtyTimer) clearTimeout(bendDirtyTimer)
  bendDirtyTimer = setTimeout(() => { bendDirty.value = false }, ms)
}
watch(() => props.chassis.lift?.encoder, v => {
  if (v === undefined || liftDirty.value) return
  liftTarget.value = Math.min(Math.max(v, LIFT_MIN_MM), LIFT_MAX_MM)
})
watch(() => props.chassis.bend?.encoder, v => {
  if (v === undefined || bendDirty.value) return
  bendTarget.value = v
})

// 位置列格式（与底条 ChassisStrip 同口径）
function enc(m: MotorElectric): string {
  if (m.name === 'lift_motor') return `${m.encoder.toFixed(0)}mm`
  if (m.name.startsWith('wheel_')) return `${toWheelPulse(m.encoder)} pulse`
  return `${m.encoder.toFixed(1)}°`
}
function vel(m: MotorElectric): string { return `${toRpm(m.velocity).toFixed(1)} RPM` }
function hasFault(m: MotorElectric | null): boolean {
  return !!m && (m.errorCode !== 0 || m.statusCode !== 0)
}
function stat(m: MotorElectric): string {
  if (m.errorCode !== 0) return `E${m.errorCode}`
  if (m.statusCode !== 0) return `S${m.statusCode}`
  return '正常'
}

/** 升降执行：钳位到真机行程后发 mm（App 层换算 m 并二次钳位）；执行后锁 2s 防回跳 */
function sendLift() {
  markLiftDirty(2000)
  emit('lift-to', Math.round(Math.min(Math.max(liftTarget.value, LIFT_MIN_MM), LIFT_MAX_MM)))
}
/** 弯腰执行：钳位 ±90° 后发 deg；执行后锁 2s 防回跳 */
function sendBend() {
  markBendDirty(2000)
  emit('bend-to', Number(Math.min(Math.max(bendTarget.value, BEND_MIN_DEG), BEND_MAX_DEG).toFixed(1)))
}
</script>

<template>
  <div class="side-panel chassis-panel">
    <div class="panel-title">底盘控制 CHASSIS</div>

    <!-- 行走/转向只读明细（底盘导航由导航组接管，V1.0.7 未开放单轮控制） -->
    <div class="ro-grid">
      <div class="ro-cap">行走 1~4 <small>pulse · RPM</small></div>
      <div class="ro-row" v-for="(m, i) in chassis.wheels" :key="m.name" :class="{ err: hasFault(m) }">
        <b>W{{ i + 1 }}</b><span>{{ enc(m) }}</span><span>{{ vel(m) }}</span>
        <span>{{ m.current.toFixed(2) }}A</span><i :class="hasFault(m) ? 'err' : 'ok'">{{ stat(m) }}</i>
      </div>
      <div class="ro-cap">转向 1~4 <small>° · RPM</small></div>
      <div class="ro-row" v-for="(m, i) in chassis.steers" :key="m.name" :class="{ err: hasFault(m) }">
        <b>S{{ i + 1 }}</b><span>{{ enc(m) }}</span><span>{{ vel(m) }}</span>
        <span>{{ m.current.toFixed(2) }}A</span><i :class="hasFault(m) ? 'err' : 'ok'">{{ stat(m) }}</i>
      </div>
    </div>

    <!-- 升降控制：目标 mm（真机行程 903.3~1453.3） -->
    <div class="ctl">
      <div class="ctl-head">
        <b>升降 Z</b>
        <span class="fb">当前 {{ chassis.lift?.encoder.toFixed(0) ?? '--' }}mm ·
          {{ chassis.lift ? vel(chassis.lift) : '--' }} ·
          {{ chassis.lift?.current.toFixed(2) ?? '--' }}A ·
          {{ chassis.lift ? stat(chassis.lift) : '--' }}</span>
      </div>
      <div class="ctl-row">
        <input type="range" :min="LIFT_MIN_MM" :max="LIFT_MAX_MM" step="1" v-model.number="liftTarget" @input="markLiftDirty()" />
        <input class="num" type="number" :min="LIFT_MIN_MM" :max="LIFT_MAX_MM" step="1" v-model.number="liftTarget" @input="markLiftDirty()" />
        <button class="btn" :disabled="busy" @click="sendLift">执行</button>
      </div>
      <div class="hint">行程 {{ LIFT_MIN_MM }}~{{ LIFT_MAX_MM }}mm（绝对高度） · 速度上限由驱动配置</div>
    </div>

    <!-- 弯腰控制：目标角度（URDF ±90°） -->
    <div class="ctl">
      <div class="ctl-head">
        <b>弯腰 B</b>
        <span class="fb">当前 {{ chassis.bend?.encoder.toFixed(1) ?? '--' }}° ·
          {{ chassis.bend ? vel(chassis.bend) : '--' }} ·
          {{ chassis.bend?.current.toFixed(2) ?? '--' }}A ·
          {{ chassis.bend ? stat(chassis.bend) : '--' }}</span>
      </div>
      <div class="ctl-row">
        <input type="range" :min="BEND_MIN_DEG" :max="BEND_MAX_DEG" step="0.5" v-model.number="bendTarget" @input="markBendDirty()" />
        <input class="num" type="number" :min="BEND_MIN_DEG" :max="BEND_MAX_DEG" step="0.5" v-model.number="bendTarget" @input="markBendDirty()" />
        <button class="btn" :disabled="busy" @click="sendBend">执行</button>
      </div>
      <div class="hint">限位 {{ BEND_MIN_DEG }}°~{{ BEND_MAX_DEG }}° · 正值=后仰（方向待真机对照）</div>
    </div>
  </div>
</template>

<style scoped>
/* 布局对齐 side-panel 家族：全局变量取主题色，明细行紧凑等宽 */
.chassis-panel { padding:14px 16px; color:var(--tx); }
.ro-grid { margin-bottom:10px; }
.ro-cap { font-size:var(--fs-cap); color:var(--acc); letter-spacing:1px; margin:8px 0 3px; }
.ro-cap small { color:var(--dim); letter-spacing:0; margin-left:6px; }
.ro-row { display:grid; grid-template-columns:34px 1fr 1fr 62px 44px; gap:6px;
  font-size:var(--fs-cap); font-family:var(--m); line-height:1.5; }
.ro-row b { color:var(--acc); font-weight:500; }
.ro-row span { color:var(--tx); }
.ro-row i { font-style:normal; text-align:right; }
.ro-row i.ok { color:var(--grn); }
.ro-row i.err, .ro-row.err span { color:var(--red); }
.ctl { border-top:1px solid rgba(49,176,230,.14); padding-top:9px; margin-top:9px; }
.ctl-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px; }
.ctl-head b { font-size:var(--fs-title); color:#fff; letter-spacing:1px; }
.ctl-head .fb { font-size:var(--fs-cap); color:var(--dim); font-family:var(--m); }
.ctl-row { display:grid; grid-template-columns:1fr 84px 64px; gap:8px; align-items:center; }
.ctl-row input[type=range] { width:100%; accent-color:var(--acc); }
.ctl-row .num { width:100%; font-size:var(--fs-cap); padding:4px 6px; }
.hint { margin-top:4px; font-size:var(--fs-cap); color:var(--dim); }
</style>
