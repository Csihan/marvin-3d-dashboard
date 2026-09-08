<script setup lang="ts">
/**
 * @file    SysPanel.vue
 * @brief   系统控制面板：场力控制（FTArmControl）+ 系统时间设置 + 软重启
 * @author Csihan
 * @date    2026-09-03
 *
 * 链路：
 *   - 场力：sendCommand('ft_control') → comms 协议 V1.0.9 → /arm/ft_control → SDK FTArmControl
 *   - 系统：sendCommand('sys_control') → comms 协议 V1.0.9 → /arm/sys_control → SDK
 * 安全：场力控制会引发运动，执行前确认；reboot 中断控制，二次确认。
 */
import { ref } from 'vue'
import type { ArmPlanController } from '../composables/useArmPlan'
// 通用「参数说明」折叠块(2026-09-04)
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ plan: ArmPlanController; busy: boolean }>()

/** 场力控制参数 */
const armId = ref<1 | 2>(1)
const sideName = () => (armId.value === 1 ? '左臂' : '右臂')
const msg = ref('')

// 场力控制（FTArmControl）：方向向量 + 刚度 + 力 + 距离约束
const fxDir = ref<number[]>([0, 0, 1, 0, 0, 0])   // 默认沿 Z 方向
const k = ref(0)
const f = ref(0)
const freeDis = ref(0)    // mm
const dis = ref(0)        // mm
const kn = ref(0)
const tn = ref(0)
const nFreeDis = ref(0)   // 度
const ndis = ref(0)       // 度

/** 执行场力控制 */
async function runFt() {
  if (!window.confirm(`对 ${sideName()} 执行场力控制（力 ${f.value}N，位移 ${dis.value}mm）。请确认无人处于危险区域。`)) return
  const ok = await props.plan.ftControl({
    arm: armId.value,
    fxDir: [...fxDir.value],
    k: k.value, f: f.value, freeDis: freeDis.value, dis: dis.value,
    kn: kn.value, tn: tn.value, nFreeDis: nFreeDis.value, ndis: ndis.value,
  })
  msg.value = ok ? props.plan.message.value : props.plan.lastError.value
}

// —— 系统时间设置（set_time）——
const now = new Date()
const sysYear = ref(now.getFullYear())
const sysMonth = ref(now.getMonth() + 1)
const sysDay = ref(now.getDate())
const sysHour = ref(now.getHours())
const sysMinute = ref(now.getMinutes())
const sysSecond = ref(now.getSeconds())

/** 同步当前时间 */
function syncNow() {
  const d = new Date()
  sysYear.value = d.getFullYear(); sysMonth.value = d.getMonth() + 1; sysDay.value = d.getDate()
  sysHour.value = d.getHours(); sysMinute.value = d.getMinutes(); sysSecond.value = d.getSeconds()
  msg.value = '已同步为当前时间，可点击设置'
}

/** 设置控制器系统时间 */
async function setTime() {
  if (!window.confirm(`将控制器系统时间设置为 ${sysYear.value}-${sysMonth.value}-${sysDay.value} ${sysHour.value}:${sysMinute.value}:${sysSecond.value}？`)) return
  const ok = await props.plan.sysSetTime({
    year: sysYear.value, month: sysMonth.value, day: sysDay.value,
    hour: sysHour.value, minute: sysMinute.value, second: sysSecond.value,
  })
  msg.value = ok ? props.plan.message.value : props.plan.lastError.value
}

/** 软重启控制板（reboot 会中断控制） */
async function reboot() {
  if (!window.confirm('即将软重启控制器控制板！所有控制将被中断约 30 秒。确认继续？')) return
  const ok = await props.plan.sysReboot()
  msg.value = ok ? props.plan.message.value : props.plan.lastError.value
}
</script>

<template>
  <section class="sys-panel">
    <div class="panel-title">场力控制</div>

    <div class="row">
      <label><input type="radio" :value="1" v-model="armId" /> 左臂</label>
      <label><input type="radio" :value="2" v-model="armId" /> 右臂</label>
    </div>
    <div class="lbl-row"><span>力方向 [Fx Fy Fz Tx Ty Tz]</span></div>
    <div class="dir-grid">
      <template v-for="(label, i) in ['Fx', 'Fy', 'Fz', 'Tx', 'Ty', 'Tz']" :key="i">
        <span class="lbl">{{ label }}</span>
        <input type="number" v-model.number="fxDir[i]" step="0.1" :disabled="busy" />
      </template>
    </div>
    <div class="row2">
      <span class="lbl">力 F(N)</span><input type="number" v-model.number="f" step="0.1" :disabled="busy" />
      <span class="lbl">位移(mm)</span><input type="number" v-model.number="dis" step="1" :disabled="busy" />
    </div>
    <div class="row2">
      <span class="lbl">K</span><input type="number" v-model.number="k" step="1" :disabled="busy" />
      <span class="lbl">无力区(mm)</span><input type="number" v-model.number="freeDis" step="1" :disabled="busy" />
    </div>
    <div class="row2">
      <span class="lbl">Kn</span><input type="number" v-model.number="kn" step="1" :disabled="busy" />
      <span class="lbl">Tn(Nm)</span><input type="number" v-model.number="tn" step="0.1" :disabled="busy" />
    </div>
    <div class="row2">
      <span class="lbl">姿态无力(°)</span><input type="number" v-model.number="nFreeDis" step="1" :disabled="busy" />
      <span class="lbl">姿态位移(°)</span><input type="number" v-model.number="ndis" step="1" :disabled="busy" />
    </div>
    <button class="btn primary full" :disabled="busy" @click="runFt">执行场力控制（确认）</button>

    <hr class="sep-line" />

    <div class="panel-title">系统控制</div>
    <div class="lbl-row">
      <span>控制器系统时间</span>
      <button class="btn mini" :disabled="busy" @click="syncNow">同步当前</button>
    </div>
    <div class="time-grid">
      <template v-for="cfg in [
        { k: '年', v: sysYear }, { k: '月', v: sysMonth }, { k: '日', v: sysDay },
        { k: '时', v: sysHour }, { k: '分', v: sysMinute }, { k: '秒', v: sysSecond },
      ]" :key="cfg.k">
        <span class="lbl">{{ cfg.k }}</span>
        <input type="number" v-model.number="cfg.v" :disabled="busy" />
      </template>
    </div>
    <div class="btn-row">
      <button class="btn primary" :disabled="busy" @click="setTime">设置时间</button>
      <button class="btn danger" :disabled="busy" @click="reboot">软重启</button>
    </div>
    <p class="hint">{{ msg || '场力控制/系统时间/重启均为维护级操作，请谨慎使用' }}</p>

    <!-- 参数说明（2026-09-04） -->
    <PanelGuide title="场力 / 系统">
      <p class="g-p">上半区"场力控制"= 把末端放进一个虚拟力场(如恒力压紧、弹簧吸附),与「力控」页签的区别:场力是持续生效的场,力指令是单次输出。下半区为控制器维护操作。</p>
      <div class="g-row"><b>力方向 [Fx..Tz]</b><span>6 维场方向:前 3=力、后 3=力矩;如末端向下压紧 Fz=-1,其余 0</span></div>
      <div class="g-row"><b>力 F(N) / 位移(mm)</b><span>F=场的目标力;位移=允许沿场方向让出的行程,到限即停(安全限幅)</span></div>
      <div class="g-row"><b>K</b><span>场刚度:力-位移比例系数,越大"场"越硬;与阻抗 K 同理念,从小值起调</span></div>
      <div class="g-row"><b>无力区(mm)</b><span>死区:末端在死区内移动不产生力反馈,用于先接近再接触的作业;接触类任务一般设 0~2</span></div>
      <div class="g-row"><b>Kn / Tn(Nm)</b><span>姿态场增益与力矩限幅;不做姿态场时保持默认</span></div>
      <div class="g-row"><b>姿态无力(°) / 姿态位移(°)</b><span>姿态方向的死区与行程,与位移同理,单位是角度</span></div>
      <div class="g-row"><b>系统时间/软重启</b><span>同步/手填控制器时间(影响日志时间戳);软重启=控制器重启,重启期间臂失力</span></div>
      <ol class="g-steps">
        <li>场力:选臂 → 填方向/力/位移/K/死区 → 「执行场力控制（确认）」;</li>
        <li>时间:一般点「同步当前」即可,手填仅用于模拟特定时间;</li>
        <li>软重启:确认无作业进行 → 点按钮 → 等待控制器重连(ROS 状态转"已连接")。</li>
      </ol>
      <p class="g-warn">场力生效后末端会持续受力,作业完成务必退出场力模式;软重启前确认双臂不在负载保持状态(失力会掉落)。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
.row { display:flex; gap:12px; margin-bottom:6px; font-size:10px; color:var(--tx); }
.row label { display:flex; align-items:center; gap:4px; cursor:pointer; }
.row2 { display:grid; grid-template-columns:auto 1fr auto 1fr; gap:3px 6px; align-items:center; margin-bottom:4px; }
.lbl-row { display:flex; justify-content:space-between; align-items:center; font-size:9px; color:var(--dim); margin:4px 0; }
.lbl { font-size:9px; color:var(--dim); text-align:right; font-family:var(--m); }
.dir-grid { display:grid; grid-template-columns:30px 1fr; gap:3px 6px; align-items:center; margin-bottom:6px; }
.dir-grid input, .row2 input, .time-grid input { width:100%; min-width:0; }
.time-grid { display:grid; grid-template-columns:26px 1fr 26px 1fr; gap:3px 6px; align-items:center; margin-bottom:6px; }
.btn-row { display:flex; gap:8px; margin-top:6px; }
.btn-row .btn { flex:1; }
.sep-line { border:none; border-top:1px solid rgba(46,230,214,.14); margin:10px 0; }
.hint { font-size:9px; color:var(--dim); line-height:1.5; margin-top:6px; }
</style>