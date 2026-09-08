<script setup lang="ts">
/**
 * @file    GripperPanel.vue
 * @brief   单爪开度/力度/速度控制和 YAML 预设保存载入
 * @author Csihan
 * @date    2026-08-28
 *
 * 交互设计：
 *   - 大号数字显示当前开度（% + mm 双单位），一眼可读；
 *   - 三组滑条：开度（0~100%）、力度（20~100%）、速度（1~100%）；
 *   - 按钮行：初始化 / 闭合(0%) / 打开(100%) / 清错；
 *   - 预设行：输入名称保存当前开度+力度+速度 → 下拉选择载入。
 *
 * 跟手性优化（V1.3.2）：
 *   - 滑条拖动中（input 事件）：上报预览值 + 节流下发（50ms）；
 *   - 松手（change 事件）：立即发终值；
 *   - 3D 模型本地即时预览（0ms），反馈回值在拖动中不覆盖预览。
 */
import { computed, ref } from 'vue'
import StatusText from './StatusText.vue'
import { GRIP_STATUS_NAMES } from '../types/robot'
import { mToPct, pctToM } from '../utils/gripperUnits'
import type { GripperPreset, GripperStatus } from '../types/robot'

const props = defineProps<{
  title: string           // 面板标题（如"左爪 L（画面左侧）"，正面视角左爪在画面左）
  idx: 1 | 2             // 夹爪编号：1=左爪 2=右爪（与协议 gripper_id 对应）
  grip: GripperStatus     // 爪状态（响应式，来自 robotStore）
  forcePct: number        // 力度百分比（20~100）
  speedPct: number        // 速度百分比（1~100）
  presets: Record<string, GripperPreset>  // 预设点位字典（名称 → {位置/力度/速度}）
  active?: boolean        // 3D 点击选中高亮
  dim?: boolean           // 聚焦模式下淡出
  busy?: boolean          // 忙碌标志（示教/回放中禁用交互）
  dragPct?: number | null // V1.3.2：拖动中的本地预览值（null=反馈接管）
}>()

const emit = defineEmits<{
  /** 滑条拖动中（input 事件连续触发）：上报预览+节流下发 */
  positionInput: [idx: 1 | 2, pct: number]
  /** 滑条松手（change 事件）：立即发终值 */
  positionCommit: [idx: 1 | 2, pct: number]
  /** 直接设置位置（按钮触发） */
  setPosition: [idx: 1 | 2, pct: number]
  /** 设置力度百分比 */
  setForce: [idx: 1 | 2, pct: number]
  /** 设置速度百分比 */
  setSpeed: [idx: 1 | 2, pct: number]
  /** 发送夹爪命令（init / clear_error / grip 等） */
  command: [idx: 1 | 2, cmd: string, extra: Record<string, unknown>]
  /** 保存预设（名称由输入框提供） */
  savePreset: [name: string]
  /** 载入预设（整点位对象） */
  loadPreset: [preset: GripperPreset]
}>()

// ─── 预设管理 ───
/** 用户输入的预设名称（保存/载入共用） */
const presetName = ref('')
/** 预设名称列表（从 presets 字典的 keys 动态生成） */
const presetNames = computed(() => Object.keys(props.presets))

// ─── 开度显示计算 ───
// 开度：% (0=闭合/100=张满 60mm) ↔ mm 双显示；换算走 gripperUnits 单一口径
// V1.3.2：拖动中显示本地预览值（dragPct），反馈接管后回落 grip.position
const shownPct = computed(() =>
  props.dragPct !== null && props.dragPct !== undefined
    ? Math.round(props.dragPct)  // 拖动中：显示本地预览（跟手）
    : Math.round(mToPct(props.grip.position))  // 非拖动：显示 ROS 反馈值
)
/** 当前开度对应的毫米值（0~60mm 行程，PGC-300-60 口径） */
const positionMm = computed(() => (pctToM(shownPct.value) * 1000).toFixed(0))
/** 是否存在故障（错误码非零） */
const fault = computed(() => props.grip.fault)

/**
 * 滑条拖动中（input 事件连续触发）：上报预览值 + 节流下发。
 * @param pct  当前拖动位置的百分比值（0~100）
 */
function onSlide(pct: number) {
  emit('positionInput', props.idx, pct)
}

/**
 * 滑条松手（change 事件）：立即发终值（不再节流，确保最终状态精确）。
 * @param pct  松手时的百分比值
 */
function onCommit(pct: number) {
  emit('positionCommit', props.idx, pct)
}

/**
 * 保存预设按钮点击：校验名称非空后触发保存事件。
 * 预设内容 = 当前开度 + 力度 + 速度（由父组件 App.vue 收集并调用 file_server 写入 YAML）。
 */
function saveClick() {
  const name = presetName.value.trim()
  if (!name) return  // 空名称不允许保存
  emit('savePreset', name)
  presetName.value = ''  // 保存后清空输入框
}
</script>

<template>
  <!-- 单爪控制面板：开度大号数字 + 三组滑条 + 按钮行 + 预设行 -->
  <section class="side-panel" :class="{ active, dim }">
    <!-- 面板标题（如"左爪 L（画面左侧）"，标注机器人坐标系名 + 画面方位） -->
    <div class="panel-title">{{ title }}</div>

    <!-- 大号开度显示：数字（渐变色）+ % 单位 + mm 值（同行内联，省高度） -->
    <div class="big-pos">
      <span class="n">{{ shownPct }}</span><span class="u">%</span>
      <span class="mm">{{ positionMm }}mm</span>
    </div>

    <!-- 夹爪状态行：四色徽章（运动中=蓝/到位=绿/夹持=橙/掉落=红） -->
    <StatusText k="状态" :v="GRIP_STATUS_NAMES[grip.gripStatus] ?? grip.gripStatus"
                :tone="fault ? 'err' : (grip.gripStatus === 2 ? 'warn' : 'ok')" />

    <!-- 开度滑条：0~100%，拖动中 input 节流下发，松手 change 终值 -->
    <label class="slider-row">开度
      <input type="range" min="0" max="100" :value="shownPct" :disabled="busy"
             @input="onSlide(Number(($event.target as HTMLInputElement).value))"
             @change="onCommit(Number(($event.target as HTMLInputElement).value))" />
      <span>{{ shownPct }}%</span>
    </label>

    <!-- 力度滑条：20~100%（物理力 = effort/100 × 300N） -->
    <label class="slider-row">力度
      <input type="range" min="20" max="100" :value="forcePct" :disabled="busy"
             @change="emit('setForce', idx, Number(($event.target as HTMLInputElement).value))" />
      <span>{{ forcePct }}%</span>
    </label>

    <!-- 速度滑条：1~100% -->
    <label class="slider-row">速度
      <input type="range" min="1" max="100" :value="speedPct" :disabled="busy"
             @change="emit('setSpeed', idx, Number(($event.target as HTMLInputElement).value))" />
      <span>{{ speedPct }}%</span>
    </label>

    <!-- 快捷按钮行：初始化 / 闭合(0%) / 打开(100%) / 清错 -->
    <div class="button-row">
      <button class="btn" :disabled="busy" @click="emit('command', idx, 'init', {})">初始化</button>
      <button class="btn" :disabled="busy" @click="emit('setPosition', idx, 0)">闭合</button>
      <button class="btn" :disabled="busy" @click="emit('setPosition', idx, 100)">打开</button>
      <button class="btn danger" :disabled="busy" @click="emit('command', idx, 'clear_error', {})">清错</button>
    </div>

    <!-- 预设保存行：输入名称 → 点击保存（当前开度+力度+速度写入 YAML） -->
    <div class="preset-row">
      <input v-model="presetName" placeholder="预设名" @keydown.enter="saveClick" />
      <button class="btn primary" :disabled="busy" @click="saveClick">保存</button>
    </div>

    <!-- 预设载入行：下拉选择已有预设 → 点击载入（恢复开度+力度+速度） -->
    <div class="preset-row">
      <select v-model="presetName" :disabled="!presetNames.length">
        <option value="">{{ presetNames.length ? '选择预设' : '暂无预设' }}</option>
        <option v-for="name in presetNames" :key="name" :value="name">{{ name }}</option>
      </select>
      <button class="btn" :disabled="busy || !presets[presetName]"
              @click="presets[presetName] && emit('loadPreset', presets[presetName])">载入</button>
    </div>
  </section>
</template>
