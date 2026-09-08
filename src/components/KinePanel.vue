<script setup lang="ts">
/**
 * @file    KinePanel.vue
 * @brief   运动学工具面板：FK 正解（关节→末端位姿）/ IK 逆解（位姿→关节）
 * @author Csihan
 * @date    2026-09-03
 *
 * 链路：sendCommand('fk_solve'/'ik_solve') → comms 协议 V1.0.9 → /arm/fk_solve|ik_solve
 * → KinematicsSDK。单位口径：关节角 rad；TCP 位姿 m + 四元数。
 * IK 结果可一键「应用」：goJoints 直接下发到位置跟随模式。
 *
 * 2026-09-05（A5）：面板内加"位置 m + 四元数"可见单位标注，防误输。
 */
import { ref } from 'vue'
import { robotStore } from '../composables/useRobotStatus'
import type { ArmPlanController } from '../composables/useArmPlan'
// 通用「参数说明」折叠块(2026-09-04)
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ plan: ArmPlanController; busy: boolean }>()

const armId = ref<1 | 2>(1)
const sideName = () => (armId.value === 1 ? '左臂' : '右臂')
const msg = ref('')

/** FK：输入 7 关节角（rad），输出 TCP 位姿 */
const fkJoints = ref<number[]>([0, 0, 0, 0, 0, 0, 0])
const fkResult = ref<number[] | null>(null)   // [x,y,z,qw,qx,qy,qz]

/** IK：输入目标 TCP 位姿（m + 四元数），输出 7 关节角（rad） */
const ikXyz = ref<number[]>([0, 0, 0])        // 位置 m
const ikQuat = ref<number[]>([1, 0, 0, 0])    // 四元数 [w,x,y,z]
const ikResult = ref<number[] | null>(null)   // 7 关节角 rad

/** 填入当前关节角到 FK 输入 */
function fillCurrentFk() {
  const j = (armId.value === 1 ? robotStore.armL : robotStore.armR).joints.slice(0, 7)
  fkJoints.value = j.map(v => Number(v.toFixed(4)))
}

/** FK 正解 */
async function runFk() {
  const res = await props.plan.fkSolve(armId.value, [...fkJoints.value])
  if (res) {
    fkResult.value = res.map(v => Number(v.toFixed(4)))
    msg.value = props.plan.message.value
  } else {
    msg.value = props.plan.lastError.value
  }
}

/** IK 逆解 */
async function runIk() {
  const [w, x, y, z] = ikQuat.value
  const res = await props.plan.ikSolve(armId.value, {
    x: ikXyz.value[0], y: ikXyz.value[1], z: ikXyz.value[2],
    qw: w, qx: x, qy: y, qz: z,
  })
  if (res) {
    ikResult.value = res.map(v => Number(v.toFixed(4)))
    msg.value = props.plan.message.value
  } else {
    msg.value = props.plan.lastError.value
  }
}

/** 应用 IK 结果：下发到位置跟随模式 */
async function applyIk() {
  if (!ikResult.value) { msg.value = '请先执行 IK 求解'; return }
  if (!window.confirm(`向 ${sideName()} 下发 IK 结果（位置跟随模式）？请确认无人处于危险区域。`)) return
  const ok = await props.plan.goJoints(armId.value, [...ikResult.value])
  msg.value = ok ? 'IK 结果已下发' : props.plan.lastError.value
}

/** 位姿 → 人读文本 */
function fmtPose(p: number[]): string {
  if (!p || p.length !== 7) return '—'
  const [x, y, z, qw, qx, qy, qz] = p
  return `位置 [${x}, ${y}, ${z}] m · 姿态 [${qw}, ${qx}, ${qy}, ${qz}]`
}
</script>

<template>
  <section class="kine-panel">
    <div class="panel-title">运动学工具</div>

    <div class="row">
      <label><input type="radio" :value="1" v-model="armId" /> 左臂</label>
      <label><input type="radio" :value="2" v-model="armId" /> 右臂</label>
    </div>

    <!-- FK：关节 → 位姿 -->
    <div class="lbl-row">
      <span>FK 输入关节（rad）</span>
      <button class="btn mini" :disabled="busy" @click="fillCurrentFk">填入当前</button>
    </div>
    <div class="j-grid">
      <template v-for="(_, i) in 7" :key="i">
        <span class="lbl">J{{ i + 1 }}</span>
        <input type="number" v-model.number="fkJoints[i]" step="0.01" :disabled="busy" />
      </template>
    </div>
    <button class="btn primary full" :disabled="busy" @click="runFk">FK 正解</button>
    <p v-if="fkResult" class="out">{{ fmtPose(fkResult) }}</p>

    <hr class="sep-line" />

    <!-- 单位口径标注（2026-09-05 A5）：TCP 位姿 = 位置 m + 四元数，防误输 -->
    <div class="unit-tag">单位：位置 m + 四元数</div>

    <!-- IK：位姿 → 关节 -->
    <div class="lbl-row"><span>IK 目标位置（m）</span></div>
    <div class="row2">
      <span class="lbl">X</span><input type="number" v-model.number="ikXyz[0]" step="0.001" :disabled="busy" />
      <span class="lbl">Y</span><input type="number" v-model.number="ikXyz[1]" step="0.001" :disabled="busy" />
      <span class="lbl">Z</span><input type="number" v-model.number="ikXyz[2]" step="0.001" :disabled="busy" />
    </div>
    <div class="lbl-row"><span>IK 目标姿态（四元数 w x y z）</span></div>
    <div class="row2">
      <template v-for="(label, i) in ['W', 'X', 'Y', 'Z']" :key="i">
        <span class="lbl">{{ label }}</span>
        <input type="number" v-model.number="ikQuat[i]" step="0.001" :disabled="busy" />
      </template>
    </div>
    <div class="btn-row">
      <button class="btn primary" :disabled="busy" @click="runIk">IK 逆解</button>
      <button class="btn" :disabled="busy || !ikResult" @click="applyIk">应用下发</button>
    </div>
    <p v-if="ikResult" class="out">{{ ikResult.map(v => (v * 180 / Math.PI).toFixed(1)).join(', ') }}°</p>

    <p class="hint">{{ msg || 'FK/IK 由 KinematicsSDK 求解，IK 带 FK 复算校验（>2mm 拒绝）' }}</p>

    <!-- 参数说明（2026-09-04） -->
    <PanelGuide title="运动学工具">
      <p class="g-p">FK/IK 计算器:纯计算、不驱动机器人——用于离线验证目标位姿能否到达、换算关节角与笛卡尔位姿。「应用下发」是唯一会把结果发给真机的按钮。</p>
      <div class="g-row"><b>FK 正解</b><span>输入 7 个关节角(rad) → 输出末端位置(m)与姿态四元数(w x y z);验证"这个关节组合摆出来在哪"</span></div>
      <div class="g-row"><b>IK 逆解</b><span>输入目标位置 XYZ(m)+姿态四元数 → 输出 7 关节角(deg);验证"够不够得着这个点"</span></div>
      <div class="g-row"><b>四元数</b><span>w x y z,模长应为 1;可用 3D 视口的 tool0 实时值(示教/调试面板)抄过来改</span></div>
      <div class="g-row"><b>填入当前</b><span>把该臂当前关节角填入 FK 输入框,FK 结果即当前末端位姿——抓拍参考点最快的方式</span></div>
      <div class="g-row"><b>应用下发</b><span>把 IK 结果作为关节目标发给对应臂(带二次确认);结果会先经 FK 复算,位置偏差 &gt;2mm 直接拒绝执行</span></div>
      <ol class="g-steps">
        <li>FK:「填入当前」或手填关节角 → 「FK 正解」→ 读输出位姿;</li>
        <li>IK:手填目标位置+四元数 → 「IK 逆解」→ 检查输出关节角是否都在限位内;</li>
        <li>确认安全 → 「应用下发」→ 臂运动到该位姿。</li>
      </ol>
      <p class="g-warn">IK 有多解:给出的解不一定是最短路径,「应用下发」前先在 3D 视口观察摆位是否合理;接近限位/singular 的解会被复算拒绝。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
.row { display:flex; gap:12px; margin-bottom:6px; font-size:10px; color:var(--tx); }
.row label { display:flex; align-items:center; gap:4px; cursor:pointer; }
.row2 { display:grid; grid-template-columns:24px 1fr 24px 1fr 24px 1fr; gap:3px 6px; align-items:center; margin-bottom:6px; }
.lbl-row { display:flex; justify-content:space-between; align-items:center; font-size:9px; color:var(--dim); margin:4px 0; }
.unit-tag { font-size:9px; color:var(--amb); font-family:var(--m); letter-spacing:.5px;
  padding:2px 0; border-bottom:1px dashed rgba(251,191,36,.18); margin-bottom:2px; }
.lbl { font-size:9px; color:var(--dim); text-align:right; font-family:var(--m); }
.j-grid { display:grid; grid-template-columns:26px 1fr; gap:3px 6px; align-items:center; margin-bottom:6px; }
.j-grid input, .row2 input { width:100%; min-width:0; }
.btn-row { display:flex; gap:8px; margin-top:6px; }
.btn-row .btn { flex:1; }
.out { font-size:9px; color:var(--acc); font-family:var(--m); line-height:1.6; margin-top:6px; word-break:break-all; }
.sep-line { border:none; border-top:1px solid rgba(46,230,214,.14); margin:10px 0; }
.hint { font-size:9px; color:var(--dim); line-height:1.5; margin-top:6px; }
</style>