<script setup lang="ts">
/**
 * @file    StatusText.vue
 * @brief   通用纯文本键值行（无卡片：label 左对齐 + value 右对齐等宽字）
 * @author Csihan
 * @date    2026-08-28
 *
 * 组件职责：
 *   全局最小复用单元——一行「键名 | 值」纯文本展示，无卡片、无边框、无交互。
 *   被 ArmStatusPanel / GripperStatusPanel / HeadStrip / ChassisStrip / StatusDock
 *   等所有 HUD 面板广泛使用。
 *
 * 样式语义：
 *   - 左侧键名（.st-k）：dim 灰色，小字宽字距；
 *   - 右侧值（.st-v）：等宽字体，颜色由 tone prop 控制：
 *     ok=绿色、warn=琥珀色、err=红色+发光阴影、dim=灰色（默认白色）。
 */

/**
 * Props 定义。
 * @prop k    - 键名（左侧 label，如 "模式"、"状态"、"错误"）
 * @prop v    - 值（右侧 value，如 "位置"、"已使能·空闲"、"无"）
 * @prop tone - 值的颜色语义（默认无 class，白色显示）
 *   - 'ok'   : 绿色（正常状态）
 *   - 'warn' : 琥珀色（运动中/注意）
 *   - 'err'  : 红色 + 发光阴影（故障/急停）
 *   - 'dim'  : 灰色（未激活/辅助信息）
 */
defineProps<{
  k: string        // 键名（左侧）
  v: string | number  // 值（右侧）
  tone?: 'ok' | 'warn' | 'err' | 'dim'  // 值的颜色语义（默认普通）
}>()
</script>

<template>
  <div class="st">
    <!-- 键名：左对齐，dim 灰色 -->
    <span class="st-k">{{ k }}</span>
    <!-- 值：右对齐，等宽字体，颜色由 tone 控制 -->
    <span class="st-v" :class="tone">{{ v }}</span>
  </div>
</template>

<style scoped>
/* 字号走全局 --fs-row 自适应变量：大屏保持放大观感，小窗口自动收缩（2026-08-29） */
.st { display:flex; justify-content:space-between; align-items:baseline;
  padding:1px 0; font-size:var(--fs-row); line-height:1.4; }
/* 键名：dim 灰色，小字宽字距 */
.st-k { color:var(--dim); letter-spacing:.5px; }
/* 值：等宽字体，继承字号，白色基准色 */
.st-v { font-family:var(--m); font-size:inherit; color:var(--tx); }
/* ok=绿色（正常状态） */
.st-v.ok { color:var(--grn); }
/* warn=琥珀色（运动中/注意） */
.st-v.warn { color:var(--amb); }
/* err=红色 + 发光阴影（故障/急停锁定） */
.st-v.err { color:var(--red); text-shadow:0 0 6px rgba(248,113,113,.4); }
/* dim=灰色（未激活/辅助信息） */
.st-v.dim { color:var(--dim); }
</style>
