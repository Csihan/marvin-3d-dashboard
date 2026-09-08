<script setup lang="ts">
/**
 * @file    BottomDock.vue
 * @brief   底部弹窗式菜单坞：平时呼吸微光，悬停增亮，点击弹出功能面板
 * @author Csihan
 * @date    2026-08-29
 *
 * 交互设计（用户需求 + 参考"数字孪生地球"氛围）：
 *   - 平时：dock 半透明呼吸（opacity .34↔.58 循环 + 青色 glow 脉动），不干扰 3D 观感；
 *   - 悬停：dock 增亮至 1、整体上浮、菜单项依次点亮；
 *   - 点击菜单项 → 上方弹出对应面板（popover），点外部/Esc 关闭；
 *   - E-STOP 常驻右端，呼吸强度更低以保证紧急可见性。
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { DemoActionStatus } from '../types/robot'
import type { TeachController } from '../composables/useTeach'
import type { ArmPlanController } from '../composables/useArmPlan'
import TeachModePanel from './TeachModePanel.vue'
import MotionTable from './MotionTable.vue'
import ImpedancePanel from './ImpedancePanel.vue'
import ForcePanel from './ForcePanel.vue'
import PvtPanel from './PvtPanel.vue'
import ParamPanel from './ParamPanel.vue'
// Web 全覆盖机械臂控制（协议 V1.0.9，2026-09-03）：规划/协同/运动学/末端/系统
import PlanPanel from './PlanPanel.vue'
import CoPlanPanel from './CoPlanPanel.vue'
import KinePanel from './KinePanel.vue'
import EndToolPanel from './EndToolPanel.vue'
import SysPanel from './SysPanel.vue'

const props = defineProps<{
  demo: DemoActionStatus       // S 动作执行状态（id/running/result/message）
  busy: boolean                // 忙碌锁（true 时禁用按钮，防止并发命令）
  teach: TeachController       // 示教控制器（提供 rows/selectedIndex/side 等响应式状态）
  plan: ArmPlanController      // 机械臂全覆盖控制器（规划/协同/运动学/末端/系统）
  anyLocked: boolean           // 任一臂急停/故障锁定 → E-STOP 切绿色 RESET 态（2026-08-29）
}>()

const emit = defineEmits<{
  /** 执行 S 动作（如 S00~S14） */
  runAction: [id: string]
  /** 选中运动表某行 */
  selectMotion: [index: number]
  /** 重命名运动表某行 */
  renameMotion: [name: string]
  /** 删除运动表当前选中行 */
  removeMotion: []
  /** 回放运动表当前选中行 */
  replayMotion: []
  /** minimum-jerk 整列连续回放（2026-09-04 M1 新增） */
  replayAllMotion: []
  /** 打开某臂面板（预留接口） */
  openArm: [side: 'L' | 'R']
  /** 复位 3D 视角到全景 */
  resetView: []
  /** 全局急停（双臂 + 底盘） */
  stopAll: []
  /** 恢复双臂（清错 + 切回位置模式） */
  resetAll: []
}>()

// ─── 弹窗状态管理 ───
/** 当前展开的弹窗标识（null=无弹窗，'actions'/'teach'/'advanced'=对应弹窗） */
type DockKey = 'actions' | 'teach' | 'advanced' | null
const activePop = ref<DockKey>(null)

// 高级功能弹窗内页签（2026-08-31：原右侧功能库移除后，SDK 高级面板并入此处；
// 2026-09-03 Web 全覆盖扩展：+规划/协同/运动学/末端/系统 五页签）
type AdvTab = 'imp' | 'force' | 'pvt' | 'param' | 'plan' | 'coplan' | 'kine' | 'endtool' | 'sys'
const advTab = ref<AdvTab>('imp')

// 演示动作列表：S00~S14（15 个预定义动作，与 FunctionLibrary 同一口径）
const actions = computed(() =>
  Array.from({ length: 15 }, (_, i) => `S${String(i).padStart(2, '0')}`))

// S 动作状态颜色：running=琥珀动画 / ok=绿 / idle=灰 / err=红
const demoTone = computed(() =>
  props.demo.running ? 'run' : props.demo.result === 0 ? 'ok'
    : props.demo.result === null ? 'idle' : 'err')

/**
 * 切换弹窗：点击已展开的菜单项则收起，点击其他则切换。
 * @param key  菜单项标识（'actions'/'teach'/'advanced'）
 */
function togglePop(key: Exclude<DockKey, null>): void {
  activePop.value = activePop.value === key ? null : key
}

/** 执行 S 动作：向上冒泡到 App.vue 调用 teach.triggerDemo(id) */
function runAction(id: string): void {
  emit('runAction', id)
}

/** 全局点击监听：点击 dock 外部时收起弹窗（dock 内部点击由模板 @pointerdown.stop 阻断） */
function onDocPointerDown(e: PointerEvent): void {
  if (!(e.target as HTMLElement).closest('.bottom-dock')) activePop.value = null
}

/** 全局键盘监听：Esc 收起弹窗 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') activePop.value = null
}

// ─── 全局事件注册与清理 ───
window.addEventListener('pointerdown', onDocPointerDown)
window.addEventListener('keydown', onKeydown)
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', onDocPointerDown)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <!-- 底部弹窗式菜单坞：居中定位，z-index=22 保证在 3D 视口之上 -->
  <div class="bottom-dock" :class="{ 'has-pop': activePop }">

    <!-- ═══ 弹窗层：根据 activePop 值渲染对应面板（上方居中弹出，从 dock 内长出动画）═══ -->

    <!-- 演示动作弹窗：15 个 S 动作按钮网格 + 执行状态反馈 -->
    <transition name="pop">
      <div v-if="activePop === 'actions'" class="pop pop-actions" @pointerdown.stop>
        <!-- 弹窗标题 -->
        <div class="pop-title">ACTIONS · 演示动作</div>
        <!-- S00~S14 动作按钮网格（5 列排列，点击触发 demo_action_exec） -->
        <div class="act-grid">
          <button v-for="id in actions" :key="id" :disabled="busy" @click="runAction(id)">{{ id }}</button>
        </div>
        <!-- 执行状态反馈：显示当前动作 ID + 状态（执行中/成功/失败/待触发） -->
        <div class="demo" :class="demoTone">
          {{ demo.actionId || 'S--' }} ·
          {{ demo.running ? '执行中' : demo.result === 0 ? '成功' : demo.result === null ? '待触发' : demo.message || '失败' }}
        </div>
      </div>
    </transition>

    <!-- 示教程序弹窗：示教模式面板 + 运动表（进入/退出示教、记点、保存/加载、单步回放） -->
    <transition name="pop">
      <div v-if="activePop === 'teach'" class="pop pop-teach" @pointerdown.stop>
        <!-- 弹窗标题 -->
        <div class="pop-title">TEACH · 示教程序</div>
        <!-- 示教模式面板：臂选择 + 进入/退出示教 + 记点 + 文件操作 -->
        <TeachModePanel :teach="teach" :busy="busy" />
        <!-- 运动表：seq 编号 + 名称编辑 + 选中/删除/回放/整列回放 -->
        <MotionTable :rows="teach.rows.value" :selected-index="teach.selectedIndex.value" :busy="busy"
                     @select="i => emit('selectMotion', i)" @rename="n => emit('renameMotion', n)"
                     @remove="emit('removeMotion')" @replay="emit('replayMotion')"
                     @replay-all="emit('replayAllMotion')" />
      </div>
    </transition>

    <!-- 高级功能弹窗（2026-08-31：原右侧功能库移除后，SDK 高级面板并入底部 dock） -->
    <transition name="pop">
      <div v-if="activePop === 'advanced'" class="pop pop-advanced" @pointerdown.stop>
        <!-- 弹窗标题 -->
        <div class="pop-title">ADVANCED · 高级功能</div>
        <!-- 页签导航：阻抗控制 / 力控 / PVT采集 / 参数维护 / 规划 / 协同 / 运动学 / 末端 / 系统 -->
        <nav class="adv-nav">
          <button :class="{ active: advTab === 'imp' }" @click="advTab = 'imp'">阻抗控制</button>
          <button :class="{ active: advTab === 'force' }" @click="advTab = 'force'">力控</button>
          <button :class="{ active: advTab === 'pvt' }" @click="advTab = 'pvt'">PVT/采集</button>
          <button :class="{ active: advTab === 'param' }" @click="advTab = 'param'">参数/维护</button>
          <button :class="{ active: advTab === 'plan' }" @click="advTab = 'plan'">在线规划</button>
          <button :class="{ active: advTab === 'coplan' }" @click="advTab = 'coplan'">双臂协同</button>
          <button :class="{ active: advTab === 'kine' }" @click="advTab = 'kine'">运动学</button>
          <button :class="{ active: advTab === 'endtool' }" @click="advTab = 'endtool'">末端通信</button>
          <button :class="{ active: advTab === 'sys' }" @click="advTab = 'sys'">系统/场力</button>
        </nav>
        <!-- 按页签切换渲染对应面板（v-if 条件渲染，每次只显示一个） -->
        <ImpedancePanel v-if="advTab === 'imp'" :teach="teach" :busy="busy" />
        <ForcePanel v-else-if="advTab === 'force'" :teach="teach" :busy="busy" />
        <PvtPanel v-else-if="advTab === 'pvt'" :teach="teach" :busy="busy" />
        <ParamPanel v-else-if="advTab === 'param'" :teach="teach" :busy="busy" />
        <PlanPanel v-else-if="advTab === 'plan'" :plan="plan" :busy="busy" />
        <CoPlanPanel v-else-if="advTab === 'coplan'" :plan="plan" :busy="busy" />
        <KinePanel v-else-if="advTab === 'kine'" :plan="plan" :busy="busy" />
        <EndToolPanel v-else-if="advTab === 'endtool'" :plan="plan" :busy="busy" />
        <SysPanel v-else-if="advTab === 'sys'" :plan="plan" :busy="busy" />
      </div>
    </transition>

    <!-- ═══ 胶囊坞体（用户口径：只保留示教与动作入口）═══ -->
    <nav class="dock-bar">
      <!-- 动作菜单按钮：点击弹出演示动作网格 -->
      <button class="item" :class="{ active: activePop === 'actions' }" @click.stop="togglePop('actions')">
        <i class="dot"></i><span>动作</span>
      </button>
      <!-- 示教菜单按钮：点击弹出示教面板 + 运动表 -->
      <button class="item" :class="{ active: activePop === 'teach' }" @click.stop="togglePop('teach')">
        <i class="dot"></i><span>示教</span>
      </button>
      <!-- 高级功能菜单按钮：点击弹出阻抗/力控/PVT/参数页签 -->
      <button class="item" :class="{ active: activePop === 'advanced' }" @click.stop="togglePop('advanced')">
        <i class="dot"></i><span>高级</span>
      </button>
      <!-- 视图复位按钮：一键复位 3D 相机到全景俯视视角 -->
      <button class="item" @click.stop="emit('resetView')">
        <i class="dot"></i><span>视图</span>
      </button>
      <!-- 分隔符：将功能按钮与急停按钮在视觉上隔开 -->
      <i class="sep"></i>
      <!-- 双态急停按钮：
           - 正常态：红色 E-STOP（点击触发全局急停，双臂 + 底盘立即停止）
           - 锁定态：绿色 RESET（点击恢复双臂：清错 + 切回位置模式）（2026-08-29） -->
      <button v-if="anyLocked" class="item estop reset" @click.stop="emit('resetAll')">RESET 恢复</button>
      <button v-else class="item estop" @click.stop="emit('stopAll')">E-STOP</button>
    </nav>
  </div>
</template>

<style scoped>
.bottom-dock { position:absolute; bottom:20px; left:50%; transform:translateX(-50%);
  z-index:22; pointer-events:auto; }

/* —— 呼吸坞体：平时半透明微光循环，悬停增亮上浮 —— */
.dock-bar { display:flex; align-items:center; gap:4px; padding:7px 12px;
  border:1px solid rgba(46,230,214,.22); border-radius:999px;
  background:linear-gradient(160deg, rgba(6,20,38,.66), rgba(2,8,18,.55));
  backdrop-filter:blur(14px);
  animation:dock-breathe 3.6s ease-in-out infinite;
  transition:opacity .25s, transform .25s, box-shadow .25s, border-color .25s; }
.bottom-dock:hover .dock-bar { animation-play-state:paused; opacity:1; transform:translateY(-3px);
  border-color:rgba(46,230,214,.5); box-shadow:0 6px 30px rgba(46,230,214,.22), inset 0 0 18px rgba(46,230,214,.06); }
@keyframes dock-breathe {
  0%,100% { opacity:.34; box-shadow:0 2px 12px rgba(46,230,214,.06); }
  50%     { opacity:.58; box-shadow:0 4px 22px rgba(46,230,214,.16), inset 0 0 14px rgba(46,230,214,.05); }
}

.item { display:flex; align-items:center; gap:6px; border:none; background:none;
  color:var(--tx); font-family:var(--f); font-size:11px; letter-spacing:1px;
  padding:6px 12px; border-radius:999px; cursor:pointer; opacity:.85; transition:.18s; }
.item:hover { background:rgba(46,230,214,.12); color:#fff; opacity:1; }
.item.active { background:rgba(46,230,214,.16); color:#fff; box-shadow:inset 0 0 10px rgba(46,230,214,.14); }
.item .dot { width:5px; height:5px; border-radius:50%; background:var(--acc);
  box-shadow:0 0 6px var(--acc); opacity:.7; }
.item:hover .dot { opacity:1; }
.sep { width:1px; height:18px; background:rgba(46,230,214,.2); margin:0 6px; }
.estop { border:1px solid rgba(248,113,113,.5); border-radius:999px;
  background:linear-gradient(135deg, rgba(220,38,38,.85), rgba(185,28,28,.85));
  color:#fff; font-family:var(--d); font-size:10px; letter-spacing:2px;
  padding:6px 14px; box-shadow:0 0 12px rgba(220,38,38,.3); }
.estop:hover { box-shadow:0 0 20px rgba(220,38,38,.55); }
/* RESET 态：绿色脉冲，提示可一键恢复（2026-08-29） */
.estop.reset { border-color:rgba(52,211,153,.65);
  background:linear-gradient(135deg, rgba(5,150,105,.9), rgba(4,120,87,.9));
  box-shadow:0 0 12px rgba(52,211,153,.35); animation:reset-breathe 1.6s ease-in-out infinite; }
@keyframes reset-breathe {
  0%,100% { box-shadow:0 0 10px rgba(52,211,153,.28); }
  50%     { box-shadow:0 0 22px rgba(52,211,153,.55); }
}

/* —— 弹出面板：dock 上方居中弹出（2026-09-04 质感升级：
   玻璃拟态 + 顶部高光描边 + 更深aller底色，弱化"简陋表单感"）—— */
.pop { position:absolute; bottom:calc(100% + 14px); left:50%; transform:translateX(-50%);
  min-width:230px; max-height:60vh; overflow:auto;
  border:1px solid rgba(46,230,214,.28); border-radius:14px;
  background:linear-gradient(165deg, rgba(8,24,44,.97) 0%, rgba(4,14,28,.94) 55%, rgba(2,8,18,.96) 100%);
  backdrop-filter:blur(22px) saturate(1.25);
  box-shadow:0 24px 64px rgba(0,0,0,.62), 0 0 0 1px rgba(255,255,255,.04) inset,
             0 1px 0 rgba(255,255,255,.09) inset, 0 0 32px rgba(46,230,214,.10);
  padding:14px 16px 16px; }
/* 标题行：左侧竖条 + 主/副标题双行,替代原先单薄的下划线小字 */
.pop-title { display:flex; align-items:center; gap:8px;
  color:var(--acc); font-size:11px; font-weight:650; letter-spacing:2.5px;
  margin-bottom:12px; padding-bottom:9px; border-bottom:1px solid rgba(46,230,214,.16);
  position:relative; }
.pop-title::before { content:''; width:3px; height:12px; border-radius:2px;
  background:linear-gradient(180deg, var(--acc), rgba(46,230,214,.25));
  box-shadow:0 0 8px rgba(46,230,214,.55); }
.pop-actions { min-width:300px; }
.pop-teach { min-width:330px; }
.pop-advanced { min-width:460px; }
/* 页签导航：横排等宽芯片。激活态渐变+外发光,hover 微抬升,
   替代原先"两行挤压小方块"的廉价感 */
.adv-nav { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:12px;
  padding-bottom:10px; border-bottom:1px solid rgba(46,230,214,.12); }
.adv-nav button { flex:1 0 auto; min-width:64px; border:1px solid rgba(46,230,214,.2);
  background:linear-gradient(180deg, rgba(46,230,214,.06), rgba(46,230,214,.02));
  color:var(--dim); font-family:var(--f); font-size:10.5px; font-weight:600; letter-spacing:.5px;
  padding:6px 10px; border-radius:7px; cursor:pointer; transition:.16s; }
.adv-nav button:hover { background:rgba(46,230,214,.13); color:#e8fbff;
  transform:translateY(-1px); box-shadow:0 3px 10px rgba(0,0,0,.35); }
.adv-nav button.active { color:#fff; border-color:rgba(46,230,214,.75);
  background:linear-gradient(180deg, rgba(46,230,214,.28), rgba(46,230,214,.12));
  box-shadow:0 0 12px rgba(46,230,214,.28), inset 0 1px 0 rgba(255,255,255,.14); }
.pop-joints { min-width:250px; }
.joint-entry .hint-line { font-size:10px; color:var(--dim); margin-bottom:8px; line-height:1.6; }
.act-grid.two { grid-template-columns:1fr 1fr; }
/* 动作按钮网格：等距芯片,渐变底+hover 发光,视觉权重与页签一致 */
.act-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:5px; }
.act-grid button { border:1px solid rgba(46,230,214,.24);
  background:linear-gradient(180deg, rgba(46,230,214,.09), rgba(46,230,214,.03));
  color:var(--acc); border-radius:7px; font-family:var(--m); font-size:11px;
  padding:8px 0; cursor:pointer; transition:.16s; }
.act-grid button:hover { background:rgba(46,230,214,.2); color:#fff;
  box-shadow:0 0 10px rgba(46,230,214,.3); transform:translateY(-1px); }
.act-grid button:disabled { opacity:.35; cursor:not-allowed; transform:none; box-shadow:none; }
/* 执行状态条：左侧圆点指示灯 + 状态文案,替代原先孤零零一行小字 */
.demo { display:flex; align-items:center; justify-content:center; gap:6px;
  margin-top:10px; font-size:10.5px; font-family:var(--m); text-align:center;
  padding:6px 8px; border-radius:7px; background:rgba(46,230,214,.04);
  border:1px solid rgba(46,230,214,.1); }
.demo::before { content:''; width:5px; height:5px; border-radius:50%;
  background:currentColor; box-shadow:0 0 6px currentColor; opacity:.85; }
.demo.idle { color:var(--dim); }
.demo.ok { color:var(--grn); }
.demo.run { color:var(--amb); }
.demo.err { color:var(--red); }

/* 弹出动画：从 dock 内长出 */
.pop-enter-active,.pop-leave-active { transition:.22s cubic-bezier(.2,.9,.25,1.15); }
.pop-enter-from,.pop-leave-to { opacity:0; transform:translateX(-50%) translateY(10px) scale(.96); }

/* 聚焦模式下坞体让位：淡出由 App 全局 .focus-mode 级联控制 */
</style>
