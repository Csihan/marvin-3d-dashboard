<script setup lang="ts">
/**
 * @file    HeadStrip.vue
 * @brief   顶部头部信息条（纯文本常显）：左右摇头(角度/电流/状态) + 上下点头(角度/电流/状态)
 * @author Csihan
 * @date    2026-08-29
 *
 * 组件职责：
 *   顶部常显的头部状态条，左右对称排列两个电机组：
 *   - 左侧：左右摇头（yaw）角度/电流/状态
 *   - 右侧：上下点头（pitch）角度/电流/状态
 *
 * 布局：
 *   居中悬浮在 3D 视口上方（top:64px），透明衬底不遮挡场景；
 *   聚焦模式下降低透明度（opacity:.3）而非隐藏，保持可读性。
 */
import StatusText from './StatusText.vue'
import type { HeadStatus } from '../types/robot'

const props = defineProps<{
  head: HeadStatus     // 头部状态（yaw/pitch 角度 + 电流 + 错误码）
  active?: boolean     // 3D 点击选中高亮（标题变白 + 发光）
}>()

/**
 * 状态文本生成：根据 reached（到位）和 err（错误码）生成显示文本。
 * @param reached  是否到位
 * @param err      错误码（0=正常）
 * @returns        状态文本（E{code} / 正常 / 运动中）
 */
const st = (reached: boolean, err: number) =>
  err !== 0 ? `E${err}` : reached ? '正常' : '运动中'

/**
 * 状态颜色生成：错误=红 / 到位=绿 / 运动中=琥珀。
 * @param reached  是否到位
 * @param err      错误码（0=正常）
 * @returns        CSS tone 类名
 */
const tone = (reached: boolean, err: number) =>
  err !== 0 ? 'err' : reached ? 'ok' : 'warn'
</script>

<template>
  <!-- 头部状态条：居中悬浮在 3D 视口上方，透明衬底 -->
  <div class="head-strip" :class="{ active }">
    <!-- 面板标题（固定"头部"二字） -->
    <div class="hs-title">头部</div>

    <!-- ═══ 左侧：左右摇头（yaw）电机组 ═══ -->
    <div class="hs-group">
      <!-- 小标题 -->
      <div class="hs-cap">左右摇头</div>
      <!-- 角度（deg，1 位小数） -->
      <StatusText k="角度" :v="`${head.yaw.toFixed(1)}°`" tone="ok" />
      <!-- 电流（A，2 位小数） -->
      <StatusText k="电流" :v="`${head.yawCurrent.toFixed(2)}A`" tone="dim" />
      <!-- 状态（正常/运动中/错误码） -->
      <StatusText k="状态" :v="st(head.yawReached, head.yawErrorCode)" :tone="tone(head.yawReached, head.yawErrorCode)" />
    </div>

    <!-- 分隔符：左右两组之间的竖线 -->
    <i class="hs-sep"></i>

    <!-- ═══ 右侧：上下点头（pitch）电机组 ═══ -->
    <div class="hs-group">
      <!-- 小标题 -->
      <div class="hs-cap">上下点头</div>
      <!-- 角度（deg，1 位小数） -->
      <StatusText k="角度" :v="`${head.pitch.toFixed(1)}°`" tone="ok" />
      <!-- 电流（A，2 位小数） -->
      <StatusText k="电流" :v="`${head.pitchCurrent.toFixed(2)}A`" tone="dim" />
      <!-- 状态（正常/运动中/错误码） -->
      <StatusText k="状态" :v="st(head.pitchReached, head.pitchErrorCode)" :tone="tone(head.pitchReached, head.pitchErrorCode)" />
    </div>
  </div>
</template>

<style scoped>
/* 字号全部走全局自适应变量，避免放大字号后头部条自身过高/过宽（2026-08-29） */
.head-strip { position:absolute; top:64px; left:50%; transform:translateX(-50%);
  display:flex; gap:clamp(14px, 1.8vw, 36px); align-items:flex-start; z-index:5; pointer-events:auto;
  background:var(--hud-tint); border-radius:8px; padding:8px clamp(12px, 1.4vw, 26px);
  transition:opacity .3s; max-width:calc(100vw - 24px); }
/* 聚焦模式下降透明而非隐藏（2026-08-30 用户口径）：.12 在深色底上等于消失，
   提到 .3 保持可读；active（选中部位对应条）仍由 App.vue 级联恢复全亮 */
.focus-mode .head-strip { opacity:.3; pointer-events:none; }
.hs-title { font-size:var(--fs-title); font-weight:600; color:var(--acc); letter-spacing:2px;
  padding-top:4px; }
.hs-cap { font-size:var(--fs-cap); color:var(--dim); letter-spacing:1px; margin-bottom:3px; }
.hs-sep { width:1px; align-self:stretch; background:rgba(46,230,214,.14); }
</style>
