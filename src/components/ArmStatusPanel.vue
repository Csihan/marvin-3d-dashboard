<script setup lang="ts">
/**
 * @file    ArmStatusPanel.vue
 * @brief   单臂数据面板（无卡片纯文本）：模式/FSM/J1~J7 角度/错误/软急停
 * @author Csihan
 * @date    2026-08-28
 *
 * 2026-08-29：状态行改"使能 · 运动"组合语义（用户反馈使能后状态不直观）：
 * 锁定/恢复仍走 FSM 文本，正常运行时显示"已使能·空闲 / 未使能·运动中"等组合。
 *
 * 2026-09-05（手册 §2.6 审查 A4）：模式行补过渡态说明——SDK 切换模式时回显
 * 101~109（映射"切换中"），过渡态持续超过 2s 视为切换失败，用户需关注是否卡死。
 *
 * 布局：
 *   四边 HUD 中的画面左侧/右侧常显面板（纯文本，无卡片边框）；
 *   面板标题标注"ARM_L · 画面左"（正面视角下机器人左臂显示在画面左侧，2026-09-05 实测修正）。
 */
import { computed } from 'vue'
import StatusText from './StatusText.vue'
import { ARM_MODE_NAMES } from '../types/robot'
import type { ArmStatus } from '../types/robot'

const props = defineProps<{
  title: string          // 面板标题（如"左臂 ARM_L · 画面左"，正面视角左臂在画面左）
  arm: ArmStatus         // 臂状态（响应式，来自 robotStore）
  active?: boolean       // 3D 点击选中高亮
}>()

// J1~J7 角度 deg（保留 1 位小数，从 rad 转换）
const jointDeg = computed(() => props.arm.joints.map(r => (r * 180 / Math.PI).toFixed(1)))

// 当前模式展示名：101~109 过渡态映射"切换中"（2026-09-05 A4，见 robot.ts 映射表）
const modeLabel = computed(() => ARM_MODE_NAMES[props.arm.mode] ?? `M${props.arm.mode}`)

// 是否处于模式切换过渡态（101~109）：是则给琥珀色 + 说明文字
const modeSwitching = computed(() => props.arm.mode >= 101 && props.arm.mode <= 109)

// 伺服报警非零项列表（如 "J3:33"）；空数组 = 全部正常
const servoFaults = computed(() =>
  props.arm.servoErr
    .map((c, i) => ({ j: `J${i + 1}`, c }))
    .filter(x => x.c !== 0)
    .map(x => `${x.j}:${x.c}`))

// 组合状态文本：锁定/恢复用 FSM 原文，正常态给"使能 · 运动"双语义
const stateText = computed(() => {
  if (props.arm.estop) return '急停锁定'
  if (props.arm.fsm === 'FAULT_LOCKED') return '故障锁定'
  if (props.arm.fsm === 'RECOVERING') return '恢复中'
  return `${props.arm.enabled ? '已使能' : '未使能'}·${props.arm.moving ? '运动中' : '空闲'}`
})
</script>

<template>
  <!-- 单臂状态面板（纯文本 HUD，无卡片边框） -->
  <div class="hud-block" :class="{ active }">
    <!-- 面板标题（如"左臂 ARM_L · 画面左"，标注机器人坐标系名 + 画面方位） -->
    <div class="hud-title">{{ title }}</div>

    <!-- 模式行：M0~M4 中文名（未知/下使能/位置/PVT/扭矩/协作释放(RELEASE)）；
         过渡态(101~109)显示"切换中"并着色（2026-09-05 A4） -->
    <StatusText k="模式" :v="modeLabel"
                :tone="modeSwitching ? 'warn' : (arm.mode > 0 ? 'ok' : 'dim')" />
    <!-- 过渡态说明行：切换中超过 2s 视为切换失败（手册 §2.6），一眼看出卡在哪 -->
    <StatusText v-if="modeSwitching" k="切换" v="过渡态 >2s 未结束 = 切换失败" tone="warn" />

    <!-- 状态行：组合语义（已使能·空闲 / 故障锁定 / 急停锁定 等） -->
    <StatusText k="状态" :v="stateText"
                :tone="arm.estop || arm.fault || arm.fsm === 'FAULT_LOCKED' ? 'err' : (arm.moving ? 'warn' : 'ok')" />

    <!-- ═══ J1~J7 角度双列网格 ═══ -->
    <!-- 双列排列省高度（放大字号后单列 7 行会纵向溢出）；伺服报警项标红 -->
    <div class="jgrid">
      <span class="jcell" v-for="(d, i) in jointDeg" :key="i">
        <span class="jn">J{{ i + 1 }}</span>
        <span class="jv" :class="{ err: servoFaults.some(s => s.startsWith(`J${i + 1}:`)) }">{{ d }}°</span>
      </span>
    </div>

    <!-- 错误码行：正常=无 / 故障=E{code} -->
    <StatusText k="错误" :v="arm.fault ? `E${arm.errorCode}` : '无'"
                :tone="arm.fault ? 'err' : 'ok'" />

    <!-- 伺服报警行（仅在有非零报警码时显示）：如"J3:33 J5:12" -->
    <StatusText v-if="servoFaults.length" k="伺服报警" :v="servoFaults.join(' ')" tone="err" />

    <!-- 软急停状态行：是=红色 / 否=绿色 -->
    <StatusText k="软急停" v="是" tone="err" v-if="arm.estop" />
    <StatusText k="软急停" v="否" tone="ok" v-else />

    <!-- 数据新鲜度（仅在后端读取失败时显示） -->
    <StatusText v-if="arm.stale" k="数据" v="不新鲜(读取失败)" tone="warn" />
  </div>
</template>

<style scoped>
.hud-block { pointer-events:auto; }
.hud-block.active .hud-title { color:#fff; text-shadow:0 0 8px var(--glow); }
.hud-title { font-size:var(--fs-title); font-weight:600; color:var(--acc); letter-spacing:2px;
  margin-bottom:6px; padding-bottom:5px; border-bottom:1px solid rgba(49,176,230,.15); }
/* J1~J7 双列：每格「名称左 · 角度右」，与 StatusText 行风格一致 */
.jgrid { display:grid; grid-template-columns:1fr 1fr; column-gap:16px;
  padding:2px 0; font-size:var(--fs-row); }
.jcell { display:flex; justify-content:space-between; align-items:baseline;
  padding:1px 2px; line-height:1.4; }
.jn { color:var(--dim); }
.jv { font-family:var(--m); color:var(--blu, #38bdf8); }
.jv.err { color:var(--red); }
</style>
