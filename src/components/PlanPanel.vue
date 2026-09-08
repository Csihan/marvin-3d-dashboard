<script setup lang="ts">
/**
 * @file    PlanPanel.vue
 * @brief   在线规划面板：关节空间规划 / 笛卡尔直线规划（movL）/ 中断
 * @author Csihan
 * @date    2026-09-03
 *
 * 链路：sendCommand('pln_control') → comms 协议 V1.0.9 → /arm/pln → SDK/Mock。
 * 单位口径（与 SDK 一致）：关节角 rad；笛卡尔 XYZABC = 位置 mm + ZYX 欧拉角 deg。
 * 安全：规划会引发运动，执行前必须确认弹窗。
 *
 * 2026-09-05（A5）：笛卡尔页签内加"位置 mm + XYZABC（ZYX 欧拉 deg）"可见单位标注。
 */
import { ref, watch } from 'vue'
import { robotStore } from '../composables/useRobotStatus'
import type { ArmPlanController } from '../composables/useArmPlan'
// 通用「参数说明」折叠块(2026-09-04)
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ plan: ArmPlanController; busy: boolean }>()

/** 当前选中臂 */
const armId = ref<1 | 2>(1)
const sideName = () => (armId.value === 1 ? '左臂' : '右臂')

/** 当前臂实际关节角（rad）——作为关节规划起点/笛卡尔参考角来源 */
const currentJoints = () => (armId.value === 1 ? robotStore.armL : robotStore.armR).joints.slice(0, 7)

/** 规划类型：1=关节 2=笛卡尔 */
const mode = ref<1 | 2>(1)
const msg = ref('')

// —— 关节规划参数 ——
/** 目标 7 关节角（rad） */
const stopJoints = ref<number[]>([0, 0, 0, 0, 0, 0, 0])
/** 速度/加速度比 0~100 */
const velRatio = ref(30)
const accRatio = ref(30)

// —— 笛卡尔规划参数（XYZABC = mm + ZYX deg）——
/** 起点 XYZABC（缺省用当前 FK 位姿由 useTeach 或手动填） */
const startXyzabc = ref<number[]>([0, 0, 0, 0, 0, 0])
/** 终点 XYZABC */
const endXyzabc = ref<number[]>([0, 0, 0, 0, 0, 0])
/** 速度/加速度 mm/s（0=节点默认） */
const velMmS = ref(100)
const accMmS2 = ref(100)

/** 把当前关节角（rad）填入目标（关节规划快捷操作） */
function fillCurrent() {
  const j = currentJoints()
  stopJoints.value = j.map(v => Number(v.toFixed(4)))
  msg.value = '已填入当前关节角（rad），可微调后执行'
}

/** 执行规划（确认后走 plan.plnJoint / plan.plnCart） */
async function run() {
  const arm = armId.value
  if (mode.value === 1) {
    if (!window.confirm(`对 ${sideName()} 执行关节空间规划：目标 ${stopJoints.value.map(v => (v * 180 / Math.PI).toFixed(1)).join(',')}°。请确认无人处于危险区域。`)) return
    const ok = await props.plan.plnJoint({
      action: 1, arm,
      startJoints: currentJoints(),
      stopJoints: [...stopJoints.value],
      velRatio: velRatio.value, accRatio: accRatio.value,
    })
    msg.value = ok ? props.plan.message.value : props.plan.lastError.value
  } else {
    if (!window.confirm(`对 ${sideName()} 执行笛卡尔直线规划：终点 XYZABC = [${endXyzabc.value.join(', ')}]（mm+deg）。请确认。`)) return
    const ok = await props.plan.plnCart({
      action: 2, arm,
      startXyzabc: [...startXyzabc.value],
      endXyzabc: [...endXyzabc.value],
      refJoints: currentJoints().map(v => v * 180 / Math.PI),
      velMmS: velMmS.value, accMmS2: accMmS2.value, freq: 50,
    })
    msg.value = ok ? props.plan.message.value : props.plan.lastError.value
  }
}

/** 中断规划 */
async function stop() {
  const ok = await props.plan.plnStop(armId.value)
  msg.value = ok ? props.plan.message.value : props.plan.lastError.value
}

// 切换臂时刷新笛卡尔起点为 0（避免跨臂残留）
watch(armId, () => { startXyzabc.value = [0, 0, 0, 0, 0, 0] })
</script>

<template>
  <section class="plan-panel">
    <div class="panel-title">在线规划</div>

    <div class="row">
      <label><input type="radio" :value="1" v-model="armId" /> 左臂</label>
      <label><input type="radio" :value="2" v-model="armId" /> 右臂</label>
    </div>
    <div class="row">
      <label><input type="radio" :value="1" v-model="mode" /> 关节规划</label>
      <label><input type="radio" :value="2" v-model="mode" /> 笛卡尔直线</label>
    </div>

    <!-- 关节规划参数 -->
    <template v-if="mode === 1">
      <div class="lbl-row">
        <span>目标关节（rad）</span>
        <button class="btn mini" :disabled="busy" @click="fillCurrent">填入当前</button>
      </div>
      <div class="j-grid">
        <template v-for="(_, i) in 7" :key="i">
          <span class="lbl">J{{ i + 1 }}</span>
          <input type="number" v-model.number="stopJoints[i]" step="0.01" :disabled="busy" />
        </template>
      </div>
      <div class="row2">
        <span class="lbl">速度%</span><input type="number" v-model.number="velRatio" min="1" max="100" />
        <span class="lbl">加速度%</span><input type="number" v-model.number="accRatio" min="1" max="100" />
      </div>
    </template>

    <!-- 笛卡尔规划参数（XYZABC = mm + ZYX deg；2026-09-05 A5 可见单位标注防误输) -->
    <template v-else>
      <div class="unit-tag">单位：位置 mm + XYZABC（ZYX 欧拉 deg）</div>
      <div class="lbl-row"><span>起点 XYZABC（mm + deg）</span></div>
      <div class="abc-grid">
        <template v-for="(label, i) in ['X', 'Y', 'Z', 'A', 'B', 'C']" :key="'s' + i">
          <span class="lbl">{{ label }}</span>
          <input type="number" v-model.number="startXyzabc[i]" step="1" :disabled="busy" />
        </template>
      </div>
      <div class="lbl-row"><span>终点 XYZABC（mm + deg）</span></div>
      <div class="abc-grid">
        <template v-for="(label, i) in ['X', 'Y', 'Z', 'A', 'B', 'C']" :key="'e' + i">
          <span class="lbl">{{ label }}</span>
          <input type="number" v-model.number="endXyzabc[i]" step="1" :disabled="busy" />
        </template>
      </div>
      <div class="row2">
        <span class="lbl">速度 mm/s</span><input type="number" v-model.number="velMmS" min="0.1" max="500" />
        <span class="lbl">加速度</span><input type="number" v-model.number="accMmS2" min="0.1" max="500" />
      </div>
    </template>

    <div class="btn-row">
      <button class="btn primary" :disabled="busy" @click="run">执行（确认）</button>
      <button class="btn danger" :disabled="busy" @click="stop">中断</button>
    </div>
    <p class="hint">{{ msg || '在线规划：平滑轨迹执行（区别于直发）' }}</p>

    <!-- 参数说明（2026-09-04） -->
    <PanelGuide title="在线规划">
      <p class="g-p">在线规划由控制器生成平滑轨迹(梯形速度曲线),比直接下发关节角更平稳。两种模式二选一。</p>
      <div class="g-row"><b>关节规划</b><span>给 7 个关节的目标角(rad),各轴同步按比例运动;点动示教点回放、大范围摆位用它</span></div>
      <div class="g-row"><b>笛卡尔直线</b><span>给起点/终点位姿 XYZABC,末端走空间直线;XYZ=位置 mm、ABC=姿态角 deg(ZYX 欧拉),装配/轨迹类作业用它</span></div>
      <div class="g-row"><b>填入当前</b><span>把该臂当前关节角一键填进目标框,在其基础上微调最不易超限</span></div>
      <div class="g-row"><b>速度%</b><span>全局速度倍率 1~100,首跑建议 ≤30 验证路径</span></div>
      <div class="g-row"><b>加速度%</b><span>全局加速度倍率 1~100;负载大/悬臂长时调低,防抖动</span></div>
      <div class="g-row"><b>速度 mm/s</b><span>笛卡尔模式的末端直线速度,首跑 ≤50mm/s</span></div>
      <div class="g-row"><b>加速度</b><span>笛卡尔模式的 mm/s²,与速度匹配(约为速度的 5~10 倍值)避免起步顿挫</span></div>
      <ol class="g-steps">
        <li>选臂 → 选模式(关节 / 笛卡尔);</li>
        <li>关节模式:填目标角(或填入当前微调) → 设速度/加速度%;笛卡尔模式:填起终点 XYZABC → 设 mm/s 与 mm/s²;</li>
        <li>「执行（确认）」→ 轨迹平滑运行;异常随时「中断」。</li>
      </ol>
      <p class="g-warn">笛卡尔直线可能在关节空间产生大回转(接近奇异位形时),首跑务必低速并盯紧路径;执行中「中断」为立即减速停。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
.row { display:flex; gap:12px; margin-bottom:6px; font-size:10px; color:var(--tx); }
.row label { display:flex; align-items:center; gap:4px; cursor:pointer; }
.row2 { display:grid; grid-template-columns:auto 1fr auto 1fr; gap:3px 6px; align-items:center; margin-bottom:6px; }
.lbl-row { display:flex; justify-content:space-between; align-items:center; font-size:9px; color:var(--dim); margin:4px 0; }
.unit-tag { font-size:9px; color:var(--amb); font-family:var(--m); letter-spacing:.5px;
  padding:2px 0; border-bottom:1px dashed rgba(251,191,36,.18); margin-bottom:2px; }
.lbl { font-size:9px; color:var(--dim); text-align:right; font-family:var(--m); }
.j-grid { display:grid; grid-template-columns:26px 1fr; gap:3px 6px; align-items:center; margin-bottom:6px; }
.abc-grid { display:grid; grid-template-columns:26px 1fr; gap:3px 6px; align-items:center; margin-bottom:4px; }
.j-grid input, .abc-grid input, .row2 input { width:100%; min-width:0; }
.btn-row { display:flex; gap:8px; margin-top:6px; }
.btn-row .btn { flex:1; }
.hint { font-size:9px; color:var(--dim); line-height:1.5; margin-top:6px; }
</style>