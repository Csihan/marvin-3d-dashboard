<script setup lang="ts">
/**
 * @file    CoPlanPanel.vue
 * @brief   双臂协同规划面板：关节空间协同 / 笛卡尔直线协同 / 中断
 * @author Csihan
 * @date    2026-09-03
 *
 * 链路：sendCommand('co_pln_control') → comms 协议 V1.0.9 → /arm/co_pln → SDK。
 * 单位口径：关节角 rad；笛卡尔 XYZABC = 位置 mm + ZYX 欧拉角 deg（SDK）。
 * 安全：双臂协同会同时引发两臂运动，执行前必须确认弹窗。
 */
import { ref } from 'vue'
import { robotStore } from '../composables/useRobotStatus'
import type { ArmPlanController } from '../composables/useArmPlan'
// 通用「参数说明」折叠块(2026-09-04)
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ plan: ArmPlanController; busy: boolean }>()

/** 协同类型：1=关节 3=笛卡尔 */
const mode = ref<1 | 3>(1)
const msg = ref('')

/** 关节协同：两臂目标关节角（rad） */
const stopA = ref<number[]>([0, 0, 0, 0, 0, 0, 0])
const stopB = ref<number[]>([0, 0, 0, 0, 0, 0, 0])
const velRatio = ref(30)
const accRatio = ref(30)

/** 笛卡尔协同：两臂起止 XYZABC（mm + deg） */
const startA = ref<number[]>([0, 0, 0, 0, 0, 0])
const endA = ref<number[]>([0, 0, 0, 0, 0, 0])
const startB = ref<number[]>([0, 0, 0, 0, 0, 0])
const endB = ref<number[]>([0, 0, 0, 0, 0, 0])
const velMmS = ref(100)
const accMmS2 = ref(100)

/** 当前臂实际关节角（rad）——协同起点 */
const curA = () => robotStore.armL.joints.slice(0, 7)
const curB = () => robotStore.armR.joints.slice(0, 7)

/** 填入当前关节角到目标 */
function fillCurrent(side: 'A' | 'B') {
  const src = side === 'A' ? curA() : curB()
  const dst = side === 'A' ? stopA : stopB
  dst.value = src.map(v => Number(v.toFixed(4)))
  msg.value = `已填入${side === 'A' ? '左' : '右'}臂当前关节角（rad）`
}

/** 执行协同（确认后走 plan.coPlnJoint / plan.coPlnCart） */
async function run() {
  if (mode.value === 1) {
    if (!window.confirm('对双臂执行关节空间协同规划（两臂同时开始）。请确认无人处于危险区域。')) return
    const ok = await props.plan.coPlnJoint({
      action: 1,
      startA: curA(), stopA: [...stopA.value],
      startB: curB(), stopB: [...stopB.value],
      velRatio: velRatio.value, accRatio: accRatio.value,
    })
    msg.value = ok ? props.plan.message.value : props.plan.lastError.value
  } else {
    if (!window.confirm('对双臂执行笛卡尔直线协同规划（两臂沿直线同步运动）。请确认。')) return
    const ok = await props.plan.coPlnCart({
      action: 3,
      startXyzabcA: [...startA.value], endXyzabcA: [...endA.value],
      startXyzabcB: [...startB.value], endXyzabcB: [...endB.value],
      refJointsA: curA().map(v => v * 180 / Math.PI),
      refJointsB: curB().map(v => v * 180 / Math.PI),
      velMmS: velMmS.value, accMmS2: accMmS2.value, freq: 50,
    })
    msg.value = ok ? props.plan.message.value : props.plan.lastError.value
  }
}

/** 中断协同 */
async function stop() {
  const ok = await props.plan.coPlnStop()
  msg.value = ok ? props.plan.message.value : props.plan.lastError.value
}
</script>

<template>
  <section class="coplan-panel">
    <div class="panel-title">双臂协同</div>

    <div class="row">
      <label><input type="radio" :value="1" v-model="mode" /> 关节协同</label>
      <label><input type="radio" :value="3" v-model="mode" /> 笛卡尔协同</label>
    </div>

    <!-- 关节协同：两臂目标 -->
    <template v-if="mode === 1">
      <div class="lbl-row">
        <span>左臂目标（rad）</span>
        <button class="btn mini" :disabled="busy" @click="fillCurrent('A')">填入当前</button>
      </div>
      <div class="j-grid">
        <template v-for="(_, i) in 7" :key="'a' + i">
          <span class="lbl">J{{ i + 1 }}</span>
          <input type="number" v-model.number="stopA[i]" step="0.01" :disabled="busy" />
        </template>
      </div>
      <div class="lbl-row">
        <span>右臂目标（rad）</span>
        <button class="btn mini" :disabled="busy" @click="fillCurrent('B')">填入当前</button>
      </div>
      <div class="j-grid">
        <template v-for="(_, i) in 7" :key="'b' + i">
          <span class="lbl">J{{ i + 1 }}</span>
          <input type="number" v-model.number="stopB[i]" step="0.01" :disabled="busy" />
        </template>
      </div>
      <div class="row2">
        <span class="lbl">速度%</span><input type="number" v-model.number="velRatio" min="1" max="100" />
        <span class="lbl">加速度%</span><input type="number" v-model.number="accRatio" min="1" max="100" />
      </div>
    </template>

    <!-- 笛卡尔协同：两臂起止 XYZABC -->
    <template v-else>
      <div class="lbl-row"><span>左臂起点 XYZABC（mm + deg）</span></div>
      <div class="abc-grid">
        <template v-for="(label, i) in ['X', 'Y', 'Z', 'A', 'B', 'C']" :key="'sa' + i">
          <span class="lbl">{{ label }}</span><input type="number" v-model.number="startA[i]" step="1" :disabled="busy" />
        </template>
      </div>
      <div class="lbl-row"><span>左臂终点 XYZABC</span></div>
      <div class="abc-grid">
        <template v-for="(label, i) in ['X', 'Y', 'Z', 'A', 'B', 'C']" :key="'ea' + i">
          <span class="lbl">{{ label }}</span><input type="number" v-model.number="endA[i]" step="1" :disabled="busy" />
        </template>
      </div>
      <div class="lbl-row"><span>右臂起点 XYZABC</span></div>
      <div class="abc-grid">
        <template v-for="(label, i) in ['X', 'Y', 'Z', 'A', 'B', 'C']" :key="'sb' + i">
          <span class="lbl">{{ label }}</span><input type="number" v-model.number="startB[i]" step="1" :disabled="busy" />
        </template>
      </div>
      <div class="lbl-row"><span>右臂终点 XYZABC</span></div>
      <div class="abc-grid">
        <template v-for="(label, i) in ['X', 'Y', 'Z', 'A', 'B', 'C']" :key="'eb' + i">
          <span class="lbl">{{ label }}</span><input type="number" v-model.number="endB[i]" step="1" :disabled="busy" />
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
    <p class="hint">{{ msg || '双臂协同：两臂同时开始规划运动' }}</p>

    <!-- 参数说明（2026-09-04） -->
    <PanelGuide title="双臂协同">
      <p class="g-p">双臂协同 = 左右两臂<b>同时启动</b>各自的规划运动(同时开始、各自到达),适合双手搬运、对称作业。两臂目标互相独立,不会自动避碰——路径规划时要人工保证不相撞。</p>
      <div class="g-row"><b>关节协同</b><span>两臂各给 7 关节目标角(rad),参数含义与单臂「在线规划-关节规划」完全一致</span></div>
      <div class="g-row"><b>笛卡尔协同</b><span>两臂各给起止 XYZABC(mm + deg),末端走直线;A/B/C 为 ZYX 欧拉角</span></div>
      <div class="g-row"><b>填入当前</b><span>A=左臂、B=右臂,分别把对应臂当前关节角填入目标框</span></div>
      <div class="g-row"><b>速度% / 加速度%</b><span>两臂共用同一倍率(1~100),保证节奏一致;首跑 ≤30</span></div>
      <div class="g-row"><b>速度 mm/s</b><span>笛卡尔协同的末端速度,两臂相同;双手抬重物时宁慢勿快</span></div>
      <ol class="g-steps">
        <li>选模式(关节协同 / 笛卡尔协同);</li>
        <li>分别填左臂、右臂目标(建议先各臂单独在「在线规划」验证过路径);</li>
        <li>设倍率 → 「执行（确认）」两臂同时启动;异常「中断」同时停两臂。</li>
      </ol>
      <p class="g-warn">协同不会自动做双臂避碰:两臂工作空间有重叠时,先在 3D 视口低速预演路径,确认无交叉再上真机。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
.row { display:flex; gap:12px; margin-bottom:6px; font-size:10px; color:var(--tx); }
.row label { display:flex; align-items:center; gap:4px; cursor:pointer; }
.row2 { display:grid; grid-template-columns:auto 1fr auto 1fr; gap:3px 6px; align-items:center; margin-bottom:6px; }
.lbl-row { display:flex; justify-content:space-between; align-items:center; font-size:9px; color:var(--dim); margin:4px 0; }
.lbl { font-size:9px; color:var(--dim); text-align:right; font-family:var(--m); }
.j-grid { display:grid; grid-template-columns:26px 1fr; gap:3px 6px; align-items:center; margin-bottom:6px; }
.abc-grid { display:grid; grid-template-columns:26px 1fr; gap:3px 6px; align-items:center; margin-bottom:4px; }
.j-grid input, .abc-grid input, .row2 input { width:100%; min-width:0; }
.btn-row { display:flex; gap:8px; margin-top:6px; }
.btn-row .btn { flex:1; }
.hint { font-size:9px; color:var(--dim); line-height:1.5; margin-top:6px; }
</style>