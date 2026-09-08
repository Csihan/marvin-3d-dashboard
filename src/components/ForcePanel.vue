<script setup lang="ts">
/**
 * @file    ForcePanel.vue
 * @brief   力控配置面板（fc_type/方向/PID/调节上限 + 单次力指令）
 * @author Csihan
 * @date    2026-08-31
 *
 * 安全口径（计划 §3.1）：力控参数与力指令均需确认；sendForceCmd 前端钳位 ±300N，
 * 后端 setForceCmd 二次钳位写 LOG。应用参数走 teach.applyForce（mode_switch.force），
 * 发送力指令走 teach.sendForceCmd（新协议类型 force_cmd）。
 *
 * 2026-09-05（手册审查 A3）：参数说明补力控量纲口径——手册力控范围 0~50N、
 * fc_type 0=基座口径。仅说明文字，默认值与钳位逻辑不变。
 *
 * 操作流程：
 *   1. 配置力控参数（fc_type + 方向 + PID + 上限）→ 应用参数（进入扭矩模式）；
 *   2. 确认已应用参数后 → 发送力指令（±300N）。
 */
import { ref } from 'vue'
import type { TeachController } from '../composables/useTeach'
import type { ForceParams } from '../types/robot'
// 通用「参数说明」折叠块(2026-09-04)
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ teach: TeachController; busy: boolean }>()

/** 当前选中臂的中文名（左臂/右臂） */
const sideName = () => props.teach.side.value === 'arm_L' ? '左臂' : '右臂'

// ─── 力控参数输入 ───
/** SDK 力控子类型（现场默认 1） */
const fc_type = ref(1)
/** 6 维力控方向向量 [Fx, Fy, Fz, Tx, Ty, Tz]（默认全 0 = 不施加力） */
const fx_dir = ref<number[]>(Array(6).fill(0))
/** 7 维关节控制参数 ctrl[7]（PID 增益，默认全 0） */
const ctrl = ref<number[]>(Array(7).fill(0))
/** 允许调节最大范围 mm（默认 10，限制末端位移幅度） */
const lmt = ref(10)
/** 单次力指令大小 N（±300N 限制） */
const force = ref(0)
/** 操作结果消息 */
const msg = ref('')
/** 是否已应用力控参数（发送力指令前校验：必须先应用参数才能发力） */
const applied = ref(false)

/**
 * 应用力控参数：二次确认 → teach.applyForce → 进入扭矩模式（力控）。
 * 应用成功后 applied=true，才允许发送力指令。
 */
async function applyParams() {
  if (!window.confirm(`即将对 ${sideName()} 下发力控参数并进入扭矩模式（力控）。请确认无人处于危险区域。`)) return
  const p: ForceParams = { fc_type: fc_type.value, fx_dir: [...fx_dir.value], ctrl: [...ctrl.value], lmt: lmt.value }
  const ok = await props.teach.applyForce(props.teach.side.value, p)
  msg.value = ok ? props.teach.message.value : props.teach.lastError.value
  applied.value = ok
}

/**
 * 发送力指令：先校验已应用参数 → 二次确认 → teach.sendForceCmd（前端钳位 ±300N）。
 * 力指令只在力控模式（扭矩模式）下有效。
 */
async function sendForce() {
  if (!applied.value) {
    msg.value = '请先应用力控参数，再发送力指令'
    return
  }
  if (!window.confirm(`对 ${sideName()} 发送力指令 ${force.value}N？当前臂处于力控模式。`)) return
  const ok = await props.teach.sendForceCmd(props.teach.side.value, force.value)
  msg.value = ok ? props.teach.message.value : props.teach.lastError.value
}
</script>

<template>
  <!-- 力控配置面板：参数配置 + 应用 + 力指令 -->
  <section class="force-panel">
    <!-- 面板标题 -->
    <div class="panel-title">力控</div>

    <!-- 力控子类型 + 调节上限（行内排列） -->
    <div class="row">
      <span class="lbl">fc_type</span>
      <input type="number" v-model.number="fc_type" step="1" :disabled="busy" />
      <span class="lbl">lmt(mm)</span>
      <input type="number" v-model.number="lmt" step="1" :disabled="busy" />
    </div>

    <!-- ═══ 6 维方向向量 Fx,Fy,Fz,Tx,Ty,Tz ═══ -->
    <div class="sub">方向 fx_dir[6]</div>
    <div class="arr">
      <template v-for="(_, i) in fx_dir" :key="'f' + i">
        <span class="lbl">{{ ['Fx','Fy','Fz','Tx','Ty','Tz'][i] }}</span>
        <input type="number" v-model.number="fx_dir[i]" step="0.1" :disabled="busy" />
      </template>
    </div>

    <!-- ═══ 7 维控制参数 ctrl[7] ═══ -->
    <div class="sub">控制 ctrl[7]</div>
    <div class="arr">
      <template v-for="(_, i) in ctrl" :key="'c' + i">
        <span class="lbl">C{{ i + 1 }}</span>
        <input type="number" v-model.number="ctrl[i]" step="0.1" :disabled="busy" />
      </template>
    </div>

    <!-- 应用参数按钮：确认后进入扭矩模式（力控） -->
    <button class="btn primary full" :disabled="busy" @click="applyParams">应用参数（确认）</button>

    <!-- ═══ 单次力指令区 ═══ -->
    <!-- 力指令输入（±300N 限制，前端钳位） -->
    <div class="row force-row">
      <span class="lbl">力指令(N)</span>
      <input type="number" v-model.number="force" step="1" :disabled="busy" />
      <span class="range">±300</span>
    </div>

    <!-- 发送力指令按钮：必须先应用参数，二次确认后下发 -->
    <button class="btn danger full" :disabled="busy" @click="sendForce">发送力指令（确认）</button>

    <!-- 操作提示/结果消息 -->
    <p class="hint">{{ msg || '先应用参数再发力指令；力值范围 ±300N' }}</p>

    <!-- 参数说明（2026-09-04） -->
    <PanelGuide title="力控">
      <p class="g-p">力控 = 让末端按指定方向输出恒定力（恒力跟踪），用于按压、贴合、打磨等接触作业。与阻抗控制的区别：力控直接给"力目标"，阻抗给"位置弹簧"。</p>
      <div class="g-row"><b>fc_type</b><span>SDK 力控子类型,现场默认 1;协议变更时由后端文档同步,一般不动。<b>口径:</b>fc_type 0=基座口径(手册力控范围 0~50N,按基座坐标系施加)</span></div>
      <div class="g-row"><b>fx_dir[6]</b><span>力方向单位向量 [Fx Fy Fz Tx Ty Tz]:前 3 项=力方向,后 3 项=力矩方向;填 0 表示该轴不施加。例:垂直向下压 = Fz=-1</span></div>
      <div class="g-row"><b>ctrl[7]</b><span>7 维力控增益(PID 类),默认全 0=用后端内置参数;调小→柔和,调大→响应快但易抖,无把握保持 0</span></div>
      <div class="g-row"><b>lmt(mm)</b><span>允许调节的最大位移幅度(默认 10mm):末端在力方向上最多让出这么多,超出即停,是安全限幅</span></div>
      <div class="g-row"><b>力指令(N)</b><span>单次输出的目标力,范围 ±300N(前端钳位,后端二次钳位写 LOG);正负号沿 fx_dir 方向</span></div>
      <ol class="g-steps">
        <li>填 fc_type(保持 1)、方向向量 fx_dir、上限 lmt;</li>
        <li>点「应用参数（确认）」→ 进入扭矩模式,力控框架生效;</li>
        <li>填目标力(±300N)→ 点「发送力指令（确认）」→ 恒力输出;</li>
        <li>作业完成先切回位置模式,再撤人员防护。</li>
      </ol>
      <p class="g-warn">未应用参数直接发力指令会被拒绝(前端拦截)。首次调试务必把 lmt 设小(如 5mm)、力值从小往大试。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
.row { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
.lbl { font-size:9px; color:var(--dim); font-family:var(--m); }
.row input, .arr input { width:100%; min-width:0; }
.force-row { margin-top:8px; }
.range { font-size:9px; color:var(--amb); }
.sub { font-size:9px; color:var(--acc); margin:6px 0 3px; }
.arr { display:grid; grid-template-columns:26px 1fr; gap:3px 8px; align-items:center; margin-bottom:6px; }
.hint { font-size:9px; color:var(--dim); line-height:1.5; margin-top:6px; }
</style>
