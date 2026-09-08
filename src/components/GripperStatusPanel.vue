<script setup lang="ts">
/**
 * @file    GripperStatusPanel.vue
 * @brief   单爪数据面板（无卡片纯文本）：开度(mm/%)/力(N/%)/四色状态徽章/物体检测/故障
 * @author Csihan
 * @date    2026-08-28
 *
 * V1.3.1（2026-08-31）：夹爪四状态可视化升级——
 *   PGC 0x0201 四状态（0运动中/1到位/2夹持/3掉落）从小字文本升为四色徽章：
 *   运动中=蓝(动态感) / 到位=绿 / 夹持=橙(有物体) / 掉落=红(告警)；
 *   开度显示 mm（STROKE_MM=60 口径），力度补牛顿换算（MAX_FORCE_N=300）。
 *
 * 布局：
 *   四边 HUD 中的画面左侧/右侧常显面板（纯文本，无卡片边框）；
 *   面板标题标注"GRIP_L · 画面左"（正面视角下机器人左爪显示在画面左侧，2026-09-05 实测修正）。
 *   大号开度数字（渐变色）+ % 单位 + mm 值（同行内联，省高度）。
 */
import { computed } from 'vue'
import StatusText from './StatusText.vue'
import { GRIP_STATUS_NAMES } from '../types/robot'
import { MAX_FORCE_N, mToPct } from '../utils/gripperUnits'
import type { GripperStatus } from '../types/robot'

const props = defineProps<{
  title: string           // 面板标题（如"左爪 GRIP_L · 画面左"，正面视角左爪在画面左）
  grip: GripperStatus     // 爪状态（响应式，来自 robotStore）
  active?: boolean        // 3D 点击选中高亮
}>()

// 开度百分比（STROKE_M=0.06 口径：0=全闭合 100%=全张开 60mm）
const pct = computed(() => Math.round(mToPct(props.grip.position) * 100) / 100)
// 开度毫米值（0~60mm 行程）
const mm = computed(() => (props.grip.position * 1000).toFixed(1))

/**
 * 四状态徽章配色（PGC 0x0201）：
 *   蓝=运动中（动态脉冲） / 绿=到位 / 橙=夹持（有物体） / 红=掉落（告警）
 */
const badge = computed(() => {
  switch (props.grip.gripStatus) {
    case 0: return { name: GRIP_STATUS_NAMES[0], cls: 'b-move' }  // 蓝=运动中
    case 1: return { name: GRIP_STATUS_NAMES[1], cls: 'b-reach' } // 绿=到位
    case 2: return { name: GRIP_STATUS_NAMES[2], cls: 'b-hold' }  // 橙=夹持
    case 3: return { name: GRIP_STATUS_NAMES[3], cls: 'b-drop' }  // 红=掉落
    default: return { name: String(props.grip.gripStatus), cls: 'b-unk' }  // 未知码
  }
})
// 掉落态在故障叠加时归并为告警红，避免与错误行语义重复
</script>

<template>
  <!-- 单爪状态面板（纯文本 HUD，无卡片边框） -->
  <div class="hud-block" :class="{ active }">
    <!-- 面板标题（如"左爪 GRIP_L · 画面左"，标注机器人坐标系名 + 画面方位） -->
    <div class="hud-title">{{ title }}</div>

    <!-- ═══ 大号开度显示：数字（渐变色）+ % 单位 + mm 值（同行内联）═══ -->
    <div class="big-pos">
      <span class="n">{{ pct }}</span><span class="u">%</span>
      <span class="mm">{{ mm }}mm</span>
    </div>

    <!-- ═══ 四状态徽章：动态脉冲点 + 语义色（V1.3.1）═══ -->
    <!-- 运动中=蓝色脉冲动画 / 到位=绿 / 夹持=橙 / 掉落=红 -->
    <div class="badge-row">
      <span class="g-badge" :class="badge.cls">
        <i class="dot" :class="{ pulse: grip.moving }"></i>{{ badge.name }}
      </span>
    </div>

    <!-- 速度行：mm/s（从 m/s 转换） -->
    <StatusText k="速度" :v="`${(grip.velocity * 1000).toFixed(1)} mm/s`"
                :tone="grip.moving ? 'warn' : 'dim'" />

    <!-- 力度行：百分比 + 物理力（N）估算（effort/100 × 300N） -->
    <StatusText k="力度" :v="`${grip.effort.toFixed(0)}% ≈ ${Math.round(grip.effort / 100 * MAX_FORCE_N)}N`" tone="ok" />

    <!-- 物体检测行：holding 或 objectDetected 任一为 true 显示"检测到" -->
    <StatusText k="物体" :v="grip.holding || grip.objectDetected ? '检测到' : '无'"
                :tone="grip.holding || grip.objectDetected ? 'ok' : 'dim'" />

    <!-- 错误码行：正常=无 / 故障=E{code} -->
    <StatusText k="错误" :v="grip.fault ? `E${grip.errorCode}` : '无'"
                :tone="grip.fault ? 'err' : 'ok'" />
  </div>
</template>

<style scoped>
.hud-block { pointer-events:auto; }
.hud-block.active .hud-title { color:#fff; text-shadow:0 0 8px var(--glow); }
.hud-title { font-size:var(--fs-title); font-weight:600; color:var(--acc); letter-spacing:2px;
  margin-bottom:4px; padding-bottom:4px; border-bottom:1px solid rgba(49,176,230,.15); }
/* 大号开度：数字/单位/毫米值全部自适应，mm 值改为同行内联，省一整行高度（2026-08-29） */
.big-pos { text-align:center; margin:4px 0 8px; line-height:1.1; white-space:nowrap; }
.big-pos .n { font-size:var(--fs-big); font-weight:200; font-family:var(--m);
  background:linear-gradient(180deg,#fff,var(--acc) 140%);
  -webkit-background-clip:text; -webkit-text-fill-color:transparent;
  filter:drop-shadow(0 0 8px rgba(49,176,230,.25)); }
.big-pos .u { font-size:calc(var(--fs-big) * 0.42); color:var(--acc); margin-left:2px; }
.big-pos .mm { display:inline; font-size:var(--fs-row); color:var(--dim); margin-left:10px; }

/* —— 四状态徽章（V1.3.1）：圆点 + 文字，语义色与全局色调一致 —— */
.badge-row { text-align:center; margin:0 0 6px; }
.g-badge { display:inline-flex; align-items:center; gap:6px;
  font-size:var(--fs-row); font-weight:600; letter-spacing:1px;
  padding:2px 12px; border-radius:10px;
  border:1px solid currentColor; }
.g-badge .dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
/* 运动中：动态脉冲（随 grip.moving 加 pulse 类） */
.g-badge .dot.pulse { animation:pulse-anim 0.9s ease-in-out infinite; }
@keyframes pulse-anim { 0%,100% { opacity:1; transform:scale(1); }
                        50% { opacity:.35; transform:scale(.7); } }
.b-move  { color:var(--acc); background:rgba(49,176,230,.12); }   /* 蓝=运动中 */
.b-reach { color:var(--grn); background:rgba(74,222,128,.12); }   /* 绿=到位 */
.b-hold  { color:var(--amb); background:rgba(251,191,36,.12); }   /* 橙=夹持 */
.b-drop  { color:var(--red); background:rgba(248,113,113,.15);
           text-shadow:0 0 6px rgba(248,113,113,.4); }            /* 红=掉落 */
.b-unk   { color:var(--dim); }                                    /* 未知码 */
</style>
