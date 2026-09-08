<script setup lang="ts">
/**
 * @file    ArmPanel.vue
 * @brief   单臂数据面板和 J1~J7 低速点动控制（限位与 Inspector/3D 同源）
 * @author Csihan
 * @date    2026-08-29
 *
 * P0 整改：滑杆 min/max 不再写死 ±170°，统一读 URDF jointLimits
 * （useRobot3D 从 robot.joints[name].limit 提取，Inspector/3D 拖拽同一来源）。
 * 2026-08-29：新增①使能/下使能主开关（M0/M1 组合语义）②HOME 执行与
 * 7 自由度 home 角度设置（localStorage 会话记忆，yaml 标定值不动）。
 *
 * 交互设计：
 *   - 顶部：面板标题 + 使能主开关（一键切换 M0/M1）；
 *   - 状态行：模式 + FSM 状态（中文映射）；
 *   - J1~J7 滑条：每条显示关节号 + 滑条 + 当前角度（deg），限位从 URDF 读取；
 *   - 模式切换：M0~M4 五档按钮（当前模式高亮）；
 *   - 操作按钮：软急停 + 清错/恢复；
 *   - HOME 行：执行 HOME + 角度设置（localStorage 记忆）。
 *
 * 2026-09-05（手册审查 A1/A2）：
 *   - M4 展示名统一「协作释放(RELEASE)」（手册 §2.6 state=4），按钮短名+title 完整名；
 *   - 进入协作释放前提补「按住末端按钮才真正拖动，松开即停」（手册 §5.6/§12.6
 *     m_TipDI==1），确认弹窗与底部拖动提示同步更新。
 */
import { computed, ref } from 'vue'
import StatusText from './StatusText.vue'
import { jointLimits } from '../composables/useRobot3D'
import { ARM_MODE_NAMES, fsmLabel } from '../types/robot'
import type { ArmStatus } from '../types/robot'

const props = defineProps<{
  side: 'L' | 'R'         // 臂侧标识（与协议/URDF 关节名 Joint1~7_L/R 对应）
  title: string            // 面板标题（如"左臂 L（画面左侧）"，正面视角左臂在画面左）
  arm: ArmStatus           // 臂状态（响应式，来自 robotStore）
  active?: boolean         // 3D 点击选中高亮
  dim?: boolean            // 聚焦模式下淡出
}>()

const emit = defineEmits<{
  /** 单关节点动：绝对角度下发（App 层走 topic 流 + 3D 即时预览） */
  jog: [side: 'L' | 'R', joint: number, deg: number]
  /** 切换臂模式（M0~M4） */
  setMode: [side: 'L' | 'R', state: number]
  /** 单臂急停（软急停服务） */
  stop: [side: 'L' | 'R']
  /** 清错（清错 + 切回位置模式） */
  clear: []
  /** 执行 HOME（null=用 yaml 标定默认，非 null=用设置的角度） */
  home: [side: 'L' | 'R', angles: number[] | null]
}>()

// ─── 角度单位常量 ───
const DEG = 180 / Math.PI  // 弧度 → 度换算因子

/** 是否处于故障/急停锁定态（锁定时禁用所有写操作） */
const isFault = () => props.arm.fault || props.arm.estop

// ─── J 滑条 dirty 跟随（2026-08-30 用户第八轮#2）───
// 关节球/Inspector 设置角度后反馈更新，滑条必须跟随；用户拖滑条期间锁定本地值
// （防反馈刷新打断拖动），@change 下发后 1.2s 恢复跟随。
/** 每个关节的 dirty 标志：true=用户正在拖动，锁定本地值不跟随反馈 */
const jDirty = ref<boolean[]>(Array(7).fill(false))
/** 每个关节的本地临时值（dirty 期间用此值显示） */
const jLocal = ref<number[]>(Array(7).fill(0))
/** 每个关节的 dirty 解锁定时器句柄 */
const jTimers: (ReturnType<typeof setTimeout> | null)[] = Array(7).fill(null)

/**
 * 滑条显示值：交互中用本地值（dirty），否则跟随反馈值。
 * 转为 deg 保留 1 位小数显示。
 */
const jDisplay = computed(() =>
  props.arm.joints.map((v, i) => jDirty.value[i] ? jLocal.value[i] : Number((v * DEG).toFixed(1))))

/**
 * 滑条 input 事件：更新本地临时值 + 标记 dirty（锁定不跟随反馈）。
 * @param i  关节索引（0~6）
 * @param e  原始 DOM 事件
 */
function onJInput(i: number, e: Event): void {
  jLocal.value[i] = Number((e.target as HTMLInputElement).value)
  jDirty.value[i] = true  // 锁定：防反馈刷新打断拖动
}

/**
 * 滑条 change 事件（松手）：下发绝对角度 + 启动 1.2s dirty 解锁计时器。
 * @param i  关节索引（0~6）
 * @param e  原始 DOM 事件
 */
function onJChange(i: number, e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  jLocal.value[i] = v
  emit('jog', props.side, i, v)    // 绝对角度下发（App 走 topic 流 + 3D 预览）
  if (jTimers[i]) clearTimeout(jTimers[i])
  // 1.2s 后恢复跟随反馈（防反馈刷新打断拖动的保护窗口）
  jTimers[i] = setTimeout(() => { jDirty.value[i] = false }, 1200)
}

// ─── 模式切换按钮（协议 M0~M4 顺序）───
// 2026-09-05（手册 §2.6 审查）：M4 展示名统一为「协作释放(RELEASE)」——协议
// state=4=协作释放（零力拖动示教），不再称"拖动"。按钮空间有限显示"协作释放"，
// 完整"协作释放(RELEASE)"由状态行走 ARM_MODE_NAMES + title 提示承担。
// 按钮说协议数值 0~4 不变（仅 UI 呈现层命名），title 挂完整名供悬停查看。
// 当前模式由 ArmStatus.mode 高亮显示
const MODES: Record<number, string> = { 0: '下使能', 1: '位置', 2: 'PVT', 3: '扭矩', 4: '协作释放' }

/**
 * 获取指定关节的 URDF 限位（deg）；URDF 未加载前回退 ±170°。
 * @param i  关节索引（0~6）
 * @returns  { min, max } 角度限位（deg）
 */
function limit(i: number): { min: number; max: number } {
  const l = jointLimits.value[`Joint${i + 1}_${props.side}`]
  return {
    min: Math.round((l?.min ?? -170 / DEG) * DEG),
    max: Math.round((l?.max ?? 170 / DEG) * DEG),
  }
}

/** 是否处于锁定态（故障锁定/急停锁定），锁定时禁用所有写操作 */
const locked = () => props.arm.fsm === 'FAULT_LOCKED' || props.arm.fsm === 'ESTOP_LOCKED'

// ─── HOME 设置（2026-08-29）───
// 会话内 localStorage 记忆，yaml 现场标定值不回写
const HOME_KEY = `marvin_home_${props.side}`  // localStorage 键名（按臂区分）
const homeOpen = ref(false)    // HOME 角度编辑器展开/收起
const homeAngles = ref<number[]>(loadHome())  // J1~J7 HOME 角度（deg）

/**
 * 从 localStorage 加载 HOME 角度（浏览器会话记忆）。
 * @returns  7 维角度数组（deg）；无缓存时返回 yaml 标定默认值。
 */
function loadHome(): number[] {
  try {
    const raw = localStorage.getItem(HOME_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      // 校验：必须是 7 个数字的数组
      if (Array.isArray(v) && v.length === 7) return v.map(Number)
    }
  } catch (_) { /* 损坏数据走默认 */ }
 // 兜底 = 单臂 home 姿态（模型域 J2=90° 垂直向下，HOME 位约定口径）
  return props.side === 'L' ? [90, 90, 0, 0, 0, 0, 0] : [-90, 90, 0, 0, 0, 0, 0]
}

/** 捕获当前关节角度作为 HOME 值（快照当前反馈） */
function captureCurrent(): void {
  homeAngles.value = props.arm.joints.map(v => Number((v * DEG).toFixed(1)))
}

/** 保存 HOME 角度到 localStorage（浏览器会话记忆，yaml 不变） */
function saveHome(): void {
  localStorage.setItem(HOME_KEY, JSON.stringify(homeAngles.value))
}

/** 执行 HOME：将保存的角度（deg→rad）通过 emit 上报到 App.vue 调用 /robot/internal/arm/home */
function goHome(): void {
  emit('home', props.side, homeAngles.value.map(d => d * Math.PI / 180))
}

/**
 * 模式切换点击（2026-08-31 Phase1）：切到 TORQUE(M3) 前提示先配置阻抗/力控参数。
 * 阻抗/力控参数在底部 BottomDock「高级」弹窗的「阻抗控制/力控」页签配置（2026-08-31
 * 右侧功能库已移除）；此处仅确认弹窗引导，不强制阻断（用户也可先用默认参数直接进扭矩模式）。
 * @param state  目标模式（M0~M4）
 */
function onModeClick(state: number): void {
  if (state === 3) {
    const ok = window.confirm(
      `切到扭矩模式（TORQUE）前，请先在底部「高级」弹窗的「阻抗控制/力控」页签配置参数。\n未配置将使用后端默认值，可能造成意外运动。\n仍要切换到扭矩模式吗？`)
    if (!ok) return
  }
  // 2026-09-01（真机 M4 事故整改）：拖动=关节阻抗拖动，臂保持力矩、可徒手拖动示教；
  // 进入前必须确认臂静止且无干涉（SDK 静止检查不过会拒绝进入）。真机二次确认口径。
  // 2026-09-05（手册 §5.6/§12.6 执行前提）：补"按住末端按钮才真正拖动，松开即停"——
  // m_TipDI==1 时末端手动开关才是真正拖动使能条件，UI 确认弹窗如实告知。
  if (state === 4) {
    const ok = window.confirm(
      `即将进入协作释放（RELEASE）：臂保持力矩，可徒手拖动示教。\n请确认：臂完全静止、无人处于危险区域、松手后臂会停在原地。\n进入协作释放后，按住末端按钮才真正拖动、松开即停（m_TipDI==1 手动开关）。\n进入吗？`)
    if (!ok) return
  }
  emit('setMode', props.side, state)
}
</script>

<template>
  <!-- 单臂控制面板：状态显示 + J1~J7 滑条 + 模式切换 + HOME -->
  <section class="side-panel" :class="{ active, dim }">

    <!-- ═══ 面板标题行：面板名 + 使能主开关（同行右对齐）═══ -->
    <div class="panel-title-row">
      <span class="panel-title">{{ title }}</span>
      <!-- 使能主开关（2026-08-29）：M0=下使能 / M1=位置(使能) 组合语义，
           用户口径"使能之后状态怎么处理"——一个大开关给出明确状态入口 -->
      <button class="btn enable-sw" :class="{ primary: arm.mode > 0 }"
              :disabled="locked()" @click="emit('setMode', side, arm.mode > 0 ? 0 : 1)">
        {{ arm.mode > 0 ? '下使能' : '使能' }}
      </button>
    </div>

    <!-- 状态行：模式（M0~M4 中文名）+ FSM 状态（中文映射） -->
    <!-- 2026-09-05（I3）：上下两条带色点状态条——上条=模式+锁定⛓/空闲 汇总，
         下条=FSM 原文+运动 状态；锁定/故障以红色点 + ⛓ 标注，扫视一眼知当前安全态。
         纯呈现层增强，协议 M0~M4 与按钮逻辑不变。 -->
    <div class="mode-band" :class="{ locked: isFault() || locked() }">
      <span class="dot" :class="isFault() ? 'err' : (arm.mode > 0 ? 'ok' : 'dim')"></span>
      <b>{{ ARM_MODE_NAMES[arm.mode] ?? `M${arm.mode}` }}</b>
      <span v-if="locked()" class="band-tag">⛓ 锁定</span>
      <span v-else-if="isFault()" class="band-tag err">‼ 故障</span>
      <span v-else-if="arm.moving" class="band-tag">▶ 运动</span>
      <span v-else class="band-tag">● 就绪</span>
      <span class="band-sub">{{ fsmLabel(arm.fsm) }}</span>
    </div>
    <StatusText k="模式" :v="ARM_MODE_NAMES[arm.mode] ?? `M${arm.mode}`" :tone="arm.mode > 0 ? 'ok' : 'dim'" />
    <StatusText k="状态" :v="fsmLabel(arm.fsm)" :tone="isFault() ? 'err' : arm.moving ? 'warn' : 'ok'" />

    <!-- ═══ J1~J7 关节滑条列表 ═══ -->
    <!-- 每行：关节号 + 滑条 + 当前角度（deg）；title 提示 URDF 限位范围 -->
    <div class="jog-row" v-for="(_, i) in arm.joints" :key="i"
         :title="`限位 ${limit(i).min}° ~ ${limit(i).max}°`">
      <span class="jn">J{{ i + 1 }}</span>
      <!-- 滑条：URDF 限位钳制，dirty 跟随（反馈更新即滑动，拖动中锁定本地值）；
           @input 实时更新本地值 + 标记 dirty；@change 松手下发绝对角度 -->
      <input type="range" :min="limit(i).min" :max="limit(i).max" step="0.1" :value="jDisplay[i]"
             :disabled="locked()"
             :aria-label="`${title} J${i + 1}`"
             @input="onJInput(i, $event)"
             @change="onJChange(i, $event)" />
      <span class="jv">{{ jDisplay[i] }}°</span>
    </div>

    <!-- 错误码行：正常=无 / 故障=E{code} -->
    <StatusText k="错误" :v="arm.fault ? `E${arm.errorCode}` : '无'" :tone="arm.fault ? 'err' : 'ok'" />

    <!-- ═══ 模式切换按钮行（协议 M0~M4 全量）═══ -->
    <!-- 五档按钮：下使能 / 位置 / PVT / 扭矩 / 协作释放；当前模式高亮；锁定态禁用；
         按钮显示短名（画不下 RELEASE），完整名挂 title（2026-09-05 A1） -->
    <div class="mode-row">
      <button v-for="(label, state) in MODES" :key="state" class="btn mode-btn"
              :class="{ primary: arm.mode === Number(state) }"
              :title="state === '4' ? '协作释放(RELEASE)' : `${ARM_MODE_NAMES[Number(state)] ?? ''} M${state}`"
              :disabled="locked()" @click="onModeClick(Number(state))">{{ label }}</button>
    </div>

    <!-- ═══ 操作按钮行：急停 + 清错/恢复 ═══ -->
    <div class="arm-actions">
      <button class="btn danger" @click="emit('stop', side)">软急停</button>
      <!-- 锁定态显示"软急停恢复"（绿色），正常态显示"清错/解锁" -->
      <button v-if="locked()" class="btn recover" @click="emit('clear')">软急停恢复</button>
      <button v-else class="btn" @click="emit('clear')">清错/解锁</button>
    </div>

    <!-- ═══ HOME 执行 + 角度设置（2026-08-29）═══ -->
    <!-- HOME 执行按钮 + 角度编辑器展开/收起按钮 -->
    <div class="home-row">
      <button class="btn" :disabled="locked()" @click="goHome">HOME</button>
      <button class="btn" @click="homeOpen = !homeOpen">HOME设置</button>
    </div>

    <!-- HOME 角度编辑器（展开态）：7 个关节角度输入 + 设为当前 + 保存 -->
    <div v-if="homeOpen" class="home-edit">
      <!-- 7 个关节角度输入框（4 列网格排列） -->
      <div class="home-grid">
        <label v-for="(_, i) in homeAngles" :key="i">J{{ i + 1 }}
          <input type="number" step="1" v-model.number="homeAngles[i]" />°
        </label>
      </div>
      <!-- 操作按钮：设为当前（快照当前反馈角度）+ 保存（写入 localStorage） -->
      <div class="home-btns">
        <button class="btn" @click="captureCurrent">设为当前</button>
        <button class="btn" @click="saveHome">保存</button>
      </div>
      <!-- 提示文字：说明保存后的行为 -->
      <div class="home-note">保存后 HOME 按此角度执行（浏览器记忆，yaml 不变）</div>
    </div>

    <!-- ═══ 操作提示区：键鼠组合用法汇总 ═══ -->
    <div class="usage-hint">
      <b>鼠标</b>：Shift/Alt+左键拖关节球调角度（Shift=链动 Jn~J7，Alt=精调 0.005°/px）；纯左键=只转视角；双击球=聚焦+面板<br/>
      <b>键盘</b>：点球选中后 W/S ±0.5°（Shift=±3°，Ctrl=±0.05°）、Tab/D/A 切关节、Q/E 肩、Space HOME<br/>
      <b>协作释放(RELEASE)</b>：M4 腕端琥珀环=位置跟随(整臂 IK)，Shift=空间角度、Alt=链动微调；拖+滚轮=推拉深度，双击=前伸；按住末端按钮才真正拖动、松开即停；Esc 退出
    </div>
  </section>
</template>

<style scoped>
/* 2026-09-05（I3）：模式/安全汇总条——彩色呼吸点 + 模式名 + 状态标签 + FSM 原文。
   锁定/故障态整条泛红并显示 ⛓/‼；正常态淡蓝底。纯呈现，不改变任何按钮逻辑。 */
.mode-band { display:flex; align-items:center; gap:6px; padding:4px 8px; margin-bottom:6px;
  border:1px solid var(--bd); border-radius:8px; background:rgba(10,25,45,.35);
  font-size:var(--fs-row); line-height:1.2; }
.mode-band .dot { width:7px; height:7px; border-radius:50%; flex:none; }
.mode-band .dot.ok { background:#34d399; box-shadow:0 0 6px #34d399; }
.mode-band .dot.dim { background:#64748b; }
.mode-band .dot.err { background:#f87171; box-shadow:0 0 6px #f87171; }
.mode-band b { color:var(--acc); letter-spacing:1px; }
.mode-band .band-tag { padding:0 5px; border-radius:4px; font-size:10px; color:#facc15;
  background:rgba(250,204,21,.12); }
.mode-band .band-tag.err { color:#f87171; background:rgba(248,113,113,.14); }
.mode-band.locked { border-color:rgba(248,113,113,.5); background:rgba(60,10,15,.4); }
.mode-band .band-sub { margin-left:auto; color:var(--dim); font-size:10px; }
.arm-actions { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-top:7px; }
.mode-row { display:grid; grid-template-columns:repeat(5,1fr); gap:3px; margin-top:7px; }
.mode-btn { padding:6px 2px; font-size:16px; }
.btn.recover { border-color:rgba(52,211,153,.6); color:var(--grn);
  background:rgba(52,211,153,.14); box-shadow:0 0 12px rgba(52,211,153,.25); }
/* 标题行：面板名 + 使能主开关同行右对齐（2026-08-29） */
.panel-title-row { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.panel-title-row .panel-title { margin-bottom:0; }
.enable-sw { min-width:76px; padding:6px 10px; }
.enable-sw.primary { border-color:rgba(52,211,153,.6); color:var(--grn);
  background:rgba(52,211,153,.12); }
/* HOME 行与角度编辑器（2026-08-29） */
.home-row { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-top:5px; }
.home-edit { margin-top:5px; padding:6px; border:1px solid rgba(49,176,230,.15); border-radius:6px; }
.home-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:4px; }
.home-grid label { display:flex; align-items:center; gap:2px; font-size:15px; color:var(--dim); }
.home-grid input { width:100%; min-width:0; border:1px solid rgba(46,230,214,.25); background:rgba(2,10,22,.6);
  color:var(--tx); font-family:var(--m); font-size:15px; padding:2px 3px; border-radius:3px; }
.home-btns { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-top:5px; }
.home-note { margin-top:4px; font-size:13px; color:var(--dim); line-height:1.4; }
.usage-hint { margin-top:7px; font-size:15px; color:var(--dim); line-height:1.5; }
.usage-hint b { color:var(--acc); }
</style>
