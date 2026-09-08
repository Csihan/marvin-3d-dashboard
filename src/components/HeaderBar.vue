<script setup lang="ts">
/**
 * @file    HeaderBar.vue
 * @brief   系统级悬浮 HUD：顶部居中 3D 标题、右上角 MOCK/全景复位、右下角 ROS 状态与急停台
 * @author Csihan
 * @date    2026-08-29
 *
 * 2026-08-29（HUD 重构）：按用户口径"顶部只需要一个标题，状态按钮全部下场参与人机交互"。
 * - 顶部仅保留居中 3D 风格标题「双臂人形轮式机器人」；
 * - MOCK（安全门禁徽标）移入右上角角落；
 * - 2026-09-04（用户口径）：右上角「◉ 全景」复位按钮移除——底部 dock「视图」
 *   已覆盖该功能，右上角只留模式徽标 + 帮助入口；resetView emit 保留（App 侧
 *   还从底部 dock 调用），本组件不再触发它。
 * - ROS 连接状态 chip 沉到右下角，点击就地展开连接信息小卡（状态可交互）；
 * - 分臂/全局急停台固定在右下角悬浮，不遮挡机器人主视野。
 * 2026-09-05（I6）：右上角加告警聚合徽标——监听 armLFault/armRFault/gripLFault/
 * gripRFault/anyLocked，任一 true 显示红色计数徽标，点击展开异常清单小卡；
 * 全正常时隐藏。只展示（展示层），复位/急停仍走原有按钮。
 */
import { computed, ref } from 'vue'
// 2026-09-03：连接信息卡展示的 rosbridge 地址与实际连接同源（dashboard.yaml 解析结果）
import { getDashboardConfig, resolveRosBridgeUrl } from '../config/dashboardConfig'

const props = defineProps<{
  connected: boolean
  /** 后端模式徽标（V1.4.6）：mock=仿真 / real=真机 / unknown=探测中 */
  backendMode?: 'unknown' | 'mock' | 'real'
  /** 探测到的机器人名称（连接信息卡展示） */
  robotName?: string
  armLFault: boolean
  armRFault: boolean
  gripLFault: boolean
  gripRFault: boolean
  anyLocked: boolean   // 任一臂急停/故障锁定 → 主按钮切 RESET 态
  /** 底盘行走/转向电机故障数（I6：驱动底盘红点徽标） */
  wheelFaultCount?: number
}>()

defineEmits<{ stopArm: [side: 'L' | 'R']; stopAll: []; resetAll: []; resetView: []; openHelp: [] }>()

// ROS 状态小卡展开/收起：点击状态 chip 就地展示连接信息，贯彻"状态即交互入口"
const showRosInfo = ref(false)
// 告警清单小卡展开/收起（I6）
const showAlarmList = ref(false)
// rosbridge 展示地址：2026-09-03 起与实际连接同源（dashboard.yaml ros_bridge 段，
// auto=跟随页面主机；分机部署时 YAML 填 ROS 主机 IP，这里展示的即真实连接目标）
const rosBridgeUrl = resolveRosBridgeUrl(getDashboardConfig())

/** 告警条目集合：任一部件故障/锁定/底盘电机异常 → 聚合为可读清单。
 *  2026-09-05（I6）：复用 App.vue 传入的 fault 布尔 + anyLocked，底盘电机故障由
 *  wheelFaultCount（App 侧 computed 统计）驱动；全空时徽标隐藏。 */
const alarmItems = computed(() => {
  const items: { key: string; label: string }[] = []
  if (props.armLFault) items.push({ key: 'L', label: '左臂故障' })
  if (props.armRFault) items.push({ key: 'R', label: '右臂故障' })
  if (props.gripLFault) items.push({ key: 'GL', label: '左爪故障' })
  if (props.gripRFault) items.push({ key: 'GR', label: '右爪故障' })
  if (props.anyLocked) items.push({ key: 'LOCK', label: '急停/故障锁定（需 RESET）' })
  const wheelN = props.wheelFaultCount ?? 0
  if (wheelN > 0) items.push({ key: 'CH', label: `底盘行走/转向电机异常 ×${wheelN}` })
  return items
})
/** 告警总数：徽标计数用（各条目 1 计） */
const alarmCount = computed(() => alarmItems.value.length)
</script>

<template>
  <!-- 顶部：仅一个居中 3D 风格标题，背景透明悬浮在 3D 场景之上 -->
  <div class="top-title">
    <div class="title-glow"></div>
    <h1>双臂人形轮式机器人</h1>
    <div class="sub">HUMANOID WHEELED ROBOT</div>
  </div>

  <!-- 右上角角落：安全门禁徽标 + 操作指南入口（不占顶栏，作为角标存在）
       2026-09-04（用户口径）：全景复位按钮移除——底部 dock 已有「视图」复位入口,
       右上角只留模式徽标 + 帮助,减少重复入口。 -->
  <div class="corner-top">
    <!-- V1.4.6：徽标按 get_version 探测的实际后端动态显示——真机联调不误挂 MOCK -->
    <span v-if="backendMode === 'real'" class="mock real">REAL · 真机</span>
    <span v-else-if="backendMode === 'unknown'" class="mock unknown">检测中</span>
    <span v-else class="mock">MOCK</span>
    <!-- 告警聚合徽标（2026-09-05 I6）：任一臂/爪故障、锁定或底盘电机异常时显示红色计数，
         点击展开异常清单；全正常不显示 -->
    <div v-if="alarmCount" class="alarm-wrap">
      <button class="alarm-badge" @click="showAlarmList = !showAlarmList"
              :title="`${alarmCount} 项异常，点击查看`">⚠ {{ alarmCount }}</button>
      <transition name="alarm-pop">
        <div v-if="showAlarmList" class="alarm-list">
          <div class="alarm-head">异常清单</div>
          <p v-for="it in alarmItems" :key="it.key" class="alarm-item">{{ it.label }}</p>
          <p class="alarm-foot">复位请用右下角 RESET 恢复 / 急停台</p>
        </div>
      </transition>
    </div>
    <button class="btn-reset help" @click="$emit('openHelp')" title="键盘鼠标操作指南（点击打开）">? 帮助</button>
  </div>

  <!-- 右下角悬浮：ROS 连接状态（可点击展开信息卡）+ 急停台（分臂 + 双态主按钮） -->
  <div class="corner-bot">
    <div class="ros-zone">
      <button class="ros-chip" :class="{ on: connected }" @click="showRosInfo = !showRosInfo"
              title="点击查看连接信息">
        <i></i>ROS <b>{{ connected ? '已连接' : '未连接' }}</b>
      </button>
      <div v-if="showRosInfo" class="ros-info">
        <p>rosbridge {{ rosBridgeUrl }}</p>
        <p>机器人核心协议 V1.0.8 · {{ backendMode === 'real' ? '真机后端' : backendMode === 'mock' ? '模拟后端' : '后端检测中' }}<template v-if="robotName"> · {{ robotName }}</template></p>
        <p class="dim">断开自动重连 · 刷新即可重新握手</p>
      </div>
    </div>
    <div class="estop-bar">
      <button class="es-sm" :class="{ err: armLFault }" @click="$emit('stopArm', 'L')">LA</button>
      <button class="es-sm" :class="{ err: armRFault }" @click="$emit('stopArm', 'R')">RA</button>
      <!-- 双态主按钮：锁定态 = 绿色 RESET（恢复），正常态 = 红色 E-STOP（急停） -->
      <button v-if="anyLocked" class="es reset" @click="$emit('resetAll')">RESET 恢复</button>
      <button v-else class="es" @click="$emit('stopAll')">E-STOP</button>
    </div>
  </div>
</template>

<style scoped>
/* —— 顶部居中标题：透明无边框，纯文字悬浮，融合进 3D 场景 —— */
.top-title { position:absolute; z-index:20; top:14px; left:0; right:0; text-align:center; pointer-events:none; }
.title-glow { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:min(58vw,600px); height:46px;
  border-radius:23px; background:radial-gradient(ellipse 60% 100% at 50% 50%, rgba(46,230,214,.14), transparent 70%); filter:blur(2px); }
.top-title h1 { position:relative; display:inline-block; margin:0; padding:8px 28px 2px;
  font-family:var(--d); font-weight:700; font-size:clamp(15px,1.55vw,23px); letter-spacing:8px; line-height:1;
  color:#eaffff; text-shadow:0 2px 0 rgba(0,0,0,.5), 0 0 12px rgba(46,230,214,.35); }
.top-title .sub { position:relative; margin-top:3px; font-family:var(--m); font-size:8px; letter-spacing:5px; color:rgba(159,184,196,.45); }

/* —— 右上角角标：安全门禁徽标 + 全景复位 —— */
.corner-top { position:absolute; z-index:20; top:14px; right:14px; display:flex; align-items:center; gap:8px; pointer-events:auto; }
.mock { font-family:var(--m); font-size:9px; color:#fbbf24; border:1px solid rgba(251,191,36,.4); padding:3px 11px;
  border-radius:13px; letter-spacing:2px; text-shadow:0 0 8px rgba(251,191,36,.4); }
.mock.real { color:#34d399; border-color:rgba(52,211,153,.45); text-shadow:0 0 8px rgba(52,211,153,.4); }
.mock.unknown { color:var(--dim); border-color:var(--bd); text-shadow:none; }
.btn-reset { border:1px solid rgba(46,230,214,.3); background:rgba(2,10,22,.55); color:#d8ecff; font-size:10px;
  padding:5px 12px; border-radius:14px; cursor:pointer; font-family:var(--f); backdrop-filter:blur(8px); letter-spacing:1px; }
.btn-reset:hover { border-color:var(--acc); color:#fff; background:rgba(46,230,214,.12); }
.btn-reset.help { border-color:rgba(251,191,36,.4); color:#fde68a; }
.btn-reset.help:hover { border-color:#fbbf24; background:rgba(251,191,36,.14); color:#fff; }

/* —— 告警聚合徽标（2026-09-05 I6）：红色计数 + 点击展开异常清单 —— */
.alarm-wrap { position:relative; }
.alarm-badge { border:1px solid rgba(248,113,113,.55); background:rgba(220,38,38,.22);
  color:#fecaca; font-family:var(--m); font-size:10px; padding:3px 10px; border-radius:13px;
  cursor:pointer; letter-spacing:.5px; box-shadow:0 0 10px rgba(248,113,113,.35);
  animation:alarm-pulse 1.6s ease-in-out infinite; white-space:nowrap; line-height:1.4; }
.alarm-badge:hover { background:rgba(220,38,38,.4); color:#fff; }
@keyframes alarm-pulse {
  0%,100% { box-shadow:0 0 8px rgba(248,113,113,.25); }
  50%     { box-shadow:0 0 18px rgba(248,113,113,.55); }
}
.alarm-list { position:absolute; right:0; top:32px; width:230px; padding:9px 12px; border-radius:10px;
  border:1px solid rgba(248,113,113,.4); background:rgba(14,4,8,.96); font-family:var(--m);
  font-size:10px; color:var(--tx); line-height:1.7; box-shadow:0 8px 30px rgba(0,0,0,.5);
  backdrop-filter:blur(8px); }
.alarm-head { font-family:var(--d); font-size:10px; letter-spacing:2px; color:#f87171;
  border-bottom:1px solid rgba(248,113,113,.25); padding-bottom:4px; margin-bottom:4px; }
.alarm-item { margin:0; padding:2px 0; color:#fecaca; }
.alarm-item::before { content:"● "; color:#f87171; }
.alarm-foot { margin:5px 0 0; padding-top:4px; border-top:1px dashed rgba(248,113,113,.25);
  color:var(--dim); font-size:9px; }
.alarm-pop-enter-active,.alarm-pop-leave-active { transition:opacity .18s, transform .18s; }
.alarm-pop-enter-from,.alarm-pop-leave-to { opacity:0; transform:translateY(-5px); }

/* —— 右下角悬浮区：ROS 状态 + 急停台，整体不挡机器人主视野 —— */
.corner-bot { position:absolute; z-index:21; right:14px; bottom:14px; display:flex; flex-direction:column;
  align-items:flex-end; gap:8px; pointer-events:none; }
.corner-bot > * { pointer-events:auto; }
.ros-zone { position:relative; }
.ros-chip { display:flex; align-items:center; gap:6px; border:1px solid rgba(46,230,214,.25); background:rgba(2,10,22,.6);
  color:var(--dim); padding:4px 12px; border-radius:14px; cursor:pointer; font-family:var(--m); font-size:9px;
  backdrop-filter:blur(8px); }
.ros-chip i { width:7px; height:7px; border-radius:50%; background:var(--red); box-shadow:0 0 7px var(--red); }
.ros-chip.on i { background:var(--grn); box-shadow:0 0 7px var(--grn); }
.ros-chip.on { color:#d8ecff; border-color:rgba(52,211,153,.4); }
.ros-chip b { font-weight:600; color:inherit; }
.ros-info { position:absolute; right:0; bottom:34px; width:236px; padding:9px 12px; border-radius:10px;
  border:1px solid var(--bd); background:rgba(4,14,30,.94); font-family:var(--m); font-size:9px;
  color:var(--tx); line-height:1.8; box-shadow:0 8px 30px rgba(0,0,0,.45); }
.ros-info p { margin:0; }
.ros-info .dim { color:var(--dim); }

.estop-bar { display:flex; gap:8px; }
.es { border:1px solid #f87171; border-radius:8px; padding:10px 16px; cursor:pointer;
  background:linear-gradient(135deg,#dc2626,#b91c1c); color:#fff; font-family:var(--d); font-size:10px; letter-spacing:1px;
  box-shadow:0 0 18px rgba(220,38,38,.35); }
.es:hover { filter:brightness(1.15); }
.es-sm { border:1px solid rgba(248,113,113,.35); border-radius:7px; padding:9px 12px; cursor:pointer;
  background:rgba(220,38,38,.12); color:#f87171; font-family:var(--m); font-size:10px; }
.es-sm:hover { background:rgba(220,38,38,.24); }
.es-sm.err { background:rgba(220,38,38,.34); color:#fff; border-color:#f87171; box-shadow:0 0 10px rgba(248,113,113,.5); }
/* RESET 态：绿色高亮，与红色急停形成强对比，恢复入口一目了然 */
.es.reset { border-color:rgba(52,211,153,.7); background:linear-gradient(135deg,#059669,#047857);
  box-shadow:0 0 18px rgba(52,211,153,.4); animation:reset-pulse 1.6s ease-in-out infinite; }
@keyframes reset-pulse {
  0%,100% { box-shadow:0 0 12px rgba(52,211,153,.3); }
  50%     { box-shadow:0 0 24px rgba(52,211,153,.55); }
}
</style>
