<script setup lang="ts">
/**
 * @file    JointInspector.vue
 * @brief   双臂关节操作台：单关节微调、链联动、限位总览、FSM/模式/锁定与清错结果
 * @author Csihan
 * @date    2026-08-29
 *
 * P0 整改：
 *   - 显示所在臂的 模式 / FSM / 锁定状态（FAULT_LOCKED / ESTOP_LOCKED 禁写）；
 *   - 显示 jointPending（本地目标 vs ROS 反馈）：等待反馈中 / 超时告警；
 *   - 清错结果：下发后 watch fault 解除显示"已恢复"，3s 超时显示"未恢复"。
 *
 * 交互流程：
 *   1. 3D 中 Shift/Alt+点击关节球 → 选中关节 → 本面板打开；
 *   2. 滑条拖动 → 即时预览（3D 模型跟随） + 松手下发（topic 流）；
 *   3. 底部按钮：回零 / 链联动 / 急停 / 清错恢复。
 */
import { computed, ref, watch } from 'vue'
import { jointLimits, jointPending, jointPositions, JOINT_FUNCTIONS } from '../composables/useRobot3D'
import { ARM_MODE_NAMES, fsmLabel } from '../types/robot'
import type { ArmStatus } from '../types/robot'

const props = defineProps<{
  jointName: string       // URDF 关节名（如 'Joint3_L'），由 3D 选中事件传入
  arm: ArmStatus          // 所在臂的完整状态（模式/FSM/关节角/错误码等）
  busy?: boolean          // 忙碌锁（true 时禁用按钮，防止并发命令）
}>()

const emit = defineEmits<{
  /** 设置单关节角度（deg）；chain=true 时联动后续关节 */
  setJoint: [side: 'L' | 'R', jointIndex: number, deg: number, chain: boolean]
  /** 回零：将当前关节角度设为 0° */
  zero: [side: 'L' | 'R', jointIndex: number]
  /** 单臂急停（软急停服务） */
  stop: [side: 'L' | 'R']
  /** 清错（清错 + 切回位置模式） */
  clear: []
  /** 关闭面板（清选中 + 复位 3D 视角） */
  close: []
}>()

// ─── 关节索引解析 ───
/** 臂侧：从关节名后缀 '_L'/'_R' 提取 */
const side = computed(() => props.jointName.endsWith('_L') ? 'L' : 'R')
/** 关节序号（0-based）：从 'Joint3_L' 提取数字 3，减 1 得到索引 2 */
const index = computed(() => Number(props.jointName.match(/^Joint(\d)/)?.[1] ?? 1) - 1)

// ─── 角度读数（deg）───
// 主读数角（rad → deg，2026-08-30 用户第六轮#3 修复）：拖 3D 关节球时 ROS 反馈
// 滞后于本地拖动，读 props.arm.joints 会长期停在旧值。优先读 3D 预览值
// jointPositions（拖动/滑条松手即时更新），无预览（模型未加载）时回退反馈。
const deg = computed(() => {
  const preview = jointPositions.value[props.jointName]
  const rad = preview !== undefined ? preview : (props.arm.joints[index.value] ?? 0)
  return Number((rad * 180 / Math.PI).toFixed(2))
})

/** 用户拖动滑条时的本地临时值（null 表示无交互态，跟随反馈） */
const localDeg = ref<number | null>(null)
/** 滑条显示值：交互中用本地值，否则跟随反馈 */
const displayDeg = computed(() => localDeg.value ?? deg.value)

// ─── URDF 限位（deg）───
const limits = computed(() => {
  const limit = jointLimits.value[props.jointName]
  return {
    min: Math.round((limit?.min ?? -170 * Math.PI / 180) * 180 / Math.PI),
    max: Math.round((limit?.max ?? 170 * Math.PI / 180) * 180 / Math.PI),
  }
})

/** 臂标签：左臂/右臂（中文显示） */
const armLabel = computed(() => side.value === 'L' ? '左臂' : '右臂')
// J1~J7 功能名（7-DOF 构型口径，见 useRobot3D JOINT_FUNCTIONS 注释）
const jointFunc = computed(() => JOINT_FUNCTIONS[index.value] ?? '')

// ─── P0：所在臂状态机显示 ───
/** 是否处于锁定态（故障锁定/急停锁定），锁定时禁用所有写操作 */
const locked = computed(() => props.arm.fsm === 'FAULT_LOCKED' || props.arm.fsm === 'ESTOP_LOCKED')
/** 锁定态标签文本（急停锁定/故障锁定） */
const lockedLabel = computed(() =>
  props.arm.fsm === 'ESTOP_LOCKED' ? '急停锁定' : props.arm.fsm === 'FAULT_LOCKED' ? '故障锁定' : '')
/** 当前模式标签（M0~M4 中文名） */
const modeLabel = computed(() => ARM_MODE_NAMES[props.arm.mode] ?? `M${props.arm.mode}`)
/** FSM 状态文本（中文映射） */
const fsmText = computed(() => fsmLabel(props.arm.fsm))
/** FSM 状态颜色：锁定=红 / 运动中/恢复中=琥珀 / 其他=绿 */
const fsmTone = computed(() =>
  locked.value ? 'err' : props.arm.fsm === 'MOVING' || props.arm.fsm === 'RECOVERING' ? 'warn' : 'ok')

// ─── P0：pending（本地目标 vs ROS 反馈）───
/** 当前关节的 pending 状态（拖动/滑条下发后等待 ROS 反馈更新） */
const pending = computed(() => jointPending.value[props.jointName] ?? null)
/** pending 标签：显示目标角度 + 状态（等待中/超时） */
const pendingLabel = computed(() => {
  if (!pending.value) return null
  const targetDeg = (pending.value.target * 180 / Math.PI).toFixed(1)
  return pending.value.timedOut
    ? `目标 ${targetDeg}° · 反馈超时（已回退显示真实反馈）`
    : `目标 ${targetDeg}° · 等待 ROS 反馈…`
})

// ─── P0：清错结果反馈 ───
/** 清错状态机：idle → sending → recovered/timeout */
const clearState = ref<'idle' | 'sending' | 'recovered' | 'timeout'>('idle')
let clearTimer: ReturnType<typeof setTimeout> | null = null

// 监听 fault 标志变化：清错下发后，fault 解除 → 显示"已恢复"
watch(() => props.arm.fault, fault => {
  if (clearState.value === 'sending' && !fault) {
    clearState.value = 'recovered'
    if (clearTimer) clearTimeout(clearTimer)
  }
})

/** 执行清错：下发清错命令 + 启动 3s 超时计时器 */
function doClear() {
  clearState.value = 'sending'
  emit('clear')
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    // 3s 后仍未清除故障 → 显示"未恢复"告警
    if (clearState.value === 'sending') clearState.value = 'timeout'
  }, 3000)
}

/** 清错结果标签文本（按状态机映射） */
const clearLabel = computed(() => ({
  idle: '', sending: '清错已下发，等待恢复…', recovered: '清错成功：故障已恢复', timeout: '清错超时：故障未恢复，请检查驱动',
})[clearState.value])

/**
 * 滑条输入事件处理：更新本地临时值（防反馈刷新打断拖动）。
 * @param event  原始 DOM 事件（取 input.value）
 */
function input(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  localDeg.value = value
  // 下发关节角度：chain=false 表示只动当前关节
  emit('setJoint', side.value, index.value, value, false)
}
</script>

<template>
  <!-- 关节操作台：选中 3D 关节球后弹出的右侧面板 -->
  <section class="joint-inspector">
    <!-- 面板头部：臂名 + 关节序号 + 功能名 + URDF 关节名 + 关闭按钮 -->
    <header>
      <div>
        <span class="title">{{ armLabel }} · J{{ index + 1 }}<small class="jfunc">{{ jointFunc }}</small></span>
        <span class="joint-name">{{ jointName }}</span>
      </div>
      <button class="icon" @click="emit('close')">✕</button>
    </header>

    <!-- 大号角度读数：当前角度（度），1 位小数 -->
    <div class="readout">{{ displayDeg.toFixed(1) }}<small>°</small></div>

    <!-- P0：所在臂模式 / FSM / 锁定状态（实时反馈） -->
    <div class="arm-line">
      <span>模式</span><b :class="arm.mode > 0 ? 'ok' : 'dim'">{{ modeLabel }}</b>
      <span>状态</span><b :class="fsmTone">{{ fsmText }}</b>
      <span v-if="locked" class="lock">{{ lockedLabel }}</span>
    </div>

    <!-- P0：本地目标 vs ROS 反馈（pending / 超时提示） -->
    <div v-if="pendingLabel" class="pending" :class="{ timeout: pending?.timedOut }">{{ pendingLabel }}</div>

    <!-- 关节角度滑条：URDF 限位钳制，拖动时即时预览 3D 模型 -->
    <label class="range">
      <span>角度</span>
      <input type="range" :min="limits.min" :max="limits.max" step="0.1" :value="displayDeg" :disabled="busy || locked" @change="input" />
      <span class="value">{{ displayDeg.toFixed(1) }}°</span>
    </label>

    <!-- J1~J7 全部角度概览网格：当前选中关节高亮 -->
    <div class="mini-grid">
      <div v-for="(value, i) in arm.joints" :key="i" :class="{ active: i === index }">
        <span>J{{ i + 1 }}</span>
        <b>{{ (value * 180 / Math.PI).toFixed(1) }}°</b>
      </div>
    </div>

    <!-- 操作提示：限位范围 + 键鼠组合用法 -->
    <div class="hint">限位 {{ limits.min }}° ~ {{ limits.max }}°；Shift+拖 3D 关节球 = J{{ index + 1 }}~J7 链联动；Alt+拖 = 0.005°/px；纯左键 = 只转视角</div>

    <!-- 底部操作按钮行 -->
    <footer>
      <!-- 回零：将当前关节角度设为 0° -->
      <button class="btn" :disabled="busy || locked" @click="emit('zero', side, index)">回零</button>
      <!-- 链联动：从当前关节到 J7 全部跟随下发（chain=true） -->
      <button class="btn" :disabled="busy || locked" @click="emit('setJoint', side, index, deg, true)">链联动</button>
      <!-- 急停：软急停服务（/robot/internal/arm/emg_stop） -->
      <button class="btn danger" @click="emit('stop', side)">急停</button>
      <!-- 清错/恢复：锁定态显示"软急停恢复"，正常态显示"清错" -->
      <button class="btn" :class="locked ? 'recover' : ''" @click="doClear">{{ locked ? '软急停恢复' : '清错' }}</button>
    </footer>

    <!-- P0：清错结果反馈（发送中=琥珀 / 已恢复=绿 / 超时=红） -->
    <div v-if="clearLabel" class="clear-result" :class="clearState">{{ clearLabel }}</div>
  </section>
</template>

<style scoped>
.arm-line { display:flex; align-items:center; gap:6px; font-size:10px; margin:-4px 0 8px; flex-wrap:wrap; }
.arm-line span { color:var(--dim); }
.arm-line b { font-family:var(--m); font-weight:500; color:var(--tx); }
.arm-line b.ok { color:var(--grn); }
.arm-line b.dim { color:var(--dim); }
.arm-line b.warn { color:var(--amb); }
.arm-line b.err { color:var(--red); }
.arm-line .lock { color:var(--red); border:1px solid rgba(248,113,113,.45); border-radius:8px;
  padding:1px 8px; animation:lock-blink 1.2s ease-in-out infinite; }
@keyframes lock-blink { 0%,100% { opacity:1 } 50% { opacity:.45 } }
.pending { font-size:10px; font-family:var(--m); color:var(--amb); margin:-2px 0 8px; }
.pending.timeout { color:var(--red); }
.clear-result { margin-top:7px; font-size:10px; font-family:var(--m); }
.clear-result.sending { color:var(--amb); }
.clear-result.recovered { color:var(--grn); }
.clear-result.timeout { color:var(--red); }
</style>
