<script setup lang="ts">
/**
 * @file    HeadPanel.vue
 * @brief   头部控制面板（点击 3D 头部弹出）：左右摇头 yaw / 上下点头 pitch 控制
 * @author Csihan
 * @date    2026-08-30
 *
 * 控制链路（FACT-WEB-003）：human_extern_cmd{motor_control:[{motor_type,target_angle}]}
 *   motor_type=1 → comms "head"       → motor_driver 头部摇头模块（deg 域）
 *   motor_type=3 → comms "head_pitch" → motor_driver 头部点头模块（deg 域）
 * 限位取 URDF head_yaw/pitch_joint（示例模型同口径）：均 ±1.5708rad=±90°。
 * 布局对齐 ChassisPanel（side-panel 家族 + ctl-row 网格），交互语义一致：
 * 滑条/数字输入目标角 → 执行下发；反馈行实时显示当前角度/电流/状态。
 */
import { ref, watch } from 'vue'
import type { HeadStatus } from '../types/robot'

const props = defineProps<{ head: HeadStatus; busy?: boolean }>()
const emit = defineEmits<{ 'yaw-to': [deg: number]; 'pitch-to': [deg: number] }>()

// URDF 限位（rad→deg）：head_yaw_joint / head_pitch_joint 的 limit 均为 ±1.5708
const YAW_MIN = -90
const YAW_MAX = 90
const PITCH_MIN = -90
const PITCH_MAX = 90

// 目标输入态：未交互时**持续跟随反馈**（修复"滑条/数字停在旧值不更新"，用户第八轮）；
// 用户交互后 dirty 锁定本地值 1.5s（防反馈刷新打断拖动），随后恢复跟随。
const yawTarget = ref(0)
const pitchTarget = ref(0)
const yawDirty = ref(false)
const pitchDirty = ref(false)
let yawDirtyTimer: ReturnType<typeof setTimeout> | null = null
let pitchDirtyTimer: ReturnType<typeof setTimeout> | null = null
function markYawDirty(ms = 1500): void {
  yawDirty.value = true
  if (yawDirtyTimer) clearTimeout(yawDirtyTimer)
  yawDirtyTimer = setTimeout(() => { yawDirty.value = false }, ms)
}
function markPitchDirty(ms = 1500): void {
  pitchDirty.value = true
  if (pitchDirtyTimer) clearTimeout(pitchDirtyTimer)
  pitchDirtyTimer = setTimeout(() => { pitchDirty.value = false }, ms)
}
watch(() => props.head.yaw, v => { if (!yawDirty.value) yawTarget.value = v })
watch(() => props.head.pitch, v => { if (!pitchDirty.value) pitchTarget.value = v })

/** 摇头执行：钳位 ±90° 后发整数 deg（yaw 精度 1° 足够） */
function sendYaw() {
  markYawDirty(2000)
  emit('yaw-to', Math.round(Math.min(Math.max(yawTarget.value, YAW_MIN), YAW_MAX)))
}
/** 点头执行：钳位 ±90° 后发 1 位小数 deg（pitch 用于俯视操作台，保留细粒度） */
function sendPitch() {
  markPitchDirty(2000)
  emit('pitch-to', Number(Math.min(Math.max(pitchTarget.value, PITCH_MIN), PITCH_MAX).toFixed(1)))
}
</script>

<template>
  <div class="side-panel head-panel">
    <div class="panel-title">头部控制 HEAD</div>

    <!-- 左右摇头 yaw：motor_type=1 → comms "head" -->
    <div class="ctl">
      <div class="ctl-head">
        <b>左右摇头 YAW</b>
        <span class="fb">当前 {{ head.yaw.toFixed(1) }}° · {{ head.yawCurrent.toFixed(2) }}A ·
          {{ head.yawErrorCode !== 0 ? `E${head.yawErrorCode}` : (head.yawReached ? '正常' : '运动中') }}</span>
      </div>
      <div class="ctl-row">
        <input type="range" :min="YAW_MIN" :max="YAW_MAX" step="0.5" v-model.number="yawTarget" @input="markYawDirty()" />
        <input class="num" type="number" :min="YAW_MIN" :max="YAW_MAX" step="0.5" v-model.number="yawTarget" @input="markYawDirty()" />
        <button class="btn" :disabled="busy" @click="sendYaw">执行</button>
      </div>
      <div class="hint">限位 {{ YAW_MIN }}°~{{ YAW_MAX }}°（URDF ±1.5708rad）</div>
    </div>

    <!-- 上下点头 pitch：motor_type=3 → comms "head_pitch" -->
    <div class="ctl">
      <div class="ctl-head">
        <b>上下点头 PITCH</b>
        <span class="fb">当前 {{ head.pitch.toFixed(1) }}° · {{ head.pitchCurrent.toFixed(2) }}A ·
          {{ head.pitchErrorCode !== 0 ? `E${head.pitchErrorCode}` : (head.pitchReached ? '正常' : '运动中') }}</span>
      </div>
      <div class="ctl-row">
        <input type="range" :min="PITCH_MIN" :max="PITCH_MAX" step="0.5" v-model.number="pitchTarget" @input="markPitchDirty()" />
        <input class="num" type="number" :min="PITCH_MIN" :max="PITCH_MAX" step="0.5" v-model.number="pitchTarget" @input="markPitchDirty()" />
        <button class="btn" :disabled="busy" @click="sendPitch">执行</button>
      </div>
      <div class="hint">限位 {{ PITCH_MIN }}°~{{ PITCH_MAX }}°（URDF ±1.5708rad） · 正值方向待真机对照</div>
    </div>
  </div>
</template>

<style scoped>
/* 布局/配色完全对齐 ChassisPanel：同 family 的 side-panel 主题，视觉一致 */
.head-panel { padding:14px 16px; color:var(--tx); }
.ctl { border-top:1px solid rgba(49,176,230,.14); padding-top:9px; margin-top:9px; }
.ctl:first-of-type { border-top:none; padding-top:2px; margin-top:0; }
.ctl-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px; }
.ctl-head b { font-size:var(--fs-title); color:#fff; letter-spacing:1px; }
.ctl-head .fb { font-size:var(--fs-cap); color:var(--dim); font-family:var(--m); }
.ctl-row { display:grid; grid-template-columns:1fr 84px 64px; gap:8px; align-items:center; }
.ctl-row input[type=range] { width:100%; accent-color:var(--acc); }
.ctl-row .num { width:100%; font-size:var(--fs-cap); padding:4px 6px; }
.hint { margin-top:4px; font-size:var(--fs-cap); color:var(--dim); }
</style>
