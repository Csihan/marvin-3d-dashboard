<script setup lang="ts">
/**
 * @file    ImpedancePanel.vue
 * @brief   阻抗控制配置面板（关节/笛卡尔 K/D 参数下发）
 * @author Csihan
 * @date    2026-08-31
 *
 * 安全口径（计划 §3.1）：阻抗参数涉及扭矩模式，应用前必须确认弹窗；
 * 下发改走 teach.applyImpedance → manipulators_control.mode_switch（state=3 + imp_type + KD）。
 * comms 解析约定：imp_type==1 读 joint_kd(前7=K 后7=D)；imp_type==2 读 cart_kd(前6=K 后6=D)。
 *
 * 2026-09-05（手册审查 A3）：参数说明区分物理量纲——关节阻抗 K 0~22 N·m/deg、
 * D 0~1(无量纲)；笛卡尔阻抗平移 0~12000 N/m、旋转 0~600 N·m/rad、零空间 20~100。
 * 仅说明文字，默认值与钳位逻辑不变。
 */
import { ref } from 'vue'
import type { TeachController } from '../composables/useTeach'
import type { ImpedanceParams } from '../types/robot'
// 通用「参数说明」折叠块(2026-09-04):每个高级页签统一用它内联参数指南
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ teach: TeachController; busy: boolean }>()

/** 当前选中臂（与示教面板同一控制器源） */
const sideName = () => props.teach.side.value === 'arm_L' ? '左臂' : '右臂'

// 阻抗类型：1=关节阻抗 K[7]/D[7]；2=笛卡尔阻抗 K[6]/D[6]
const type = ref<1 | 2>(1)
// 动态 K/D 数组：按 type 初始化默认值（计划 §4.3：关节 K=200×7 D=20×7；笛卡尔 K=1000×6 D=100×6）
const k = ref<number[]>(Array(7).fill(200))
const d = ref<number[]>(Array(7).fill(20))
const msg = ref('')

// 切换类型时重设数组长度与默认值（保持表单与后端 size 校验一致）
function onTypeChange() {
  const n = type.value === 1 ? 7 : 6
  const kDef = type.value === 1 ? 200 : 1000
  const dDef = type.value === 1 ? 20 : 100
  k.value = Array(n).fill(kDef)
  d.value = Array(n).fill(dDef)
}

/** 应用：确认弹窗 → 组装 ImpedanceParams → teach.applyImpedance */
async function apply() {
  if (!window.confirm(`即将对 ${sideName()} 下发阻抗参数并进入扭矩模式（${type.value === 1 ? '关节' : '笛卡尔'}阻抗）。请确认无人处于危险区域。`)) return
  const p: ImpedanceParams = { type: type.value, k: [...k.value], d: [...d.value] }
  const ok = await props.teach.applyImpedance(props.teach.side.value, p)
  msg.value = ok ? props.teach.message.value : props.teach.lastError.value
}
</script>

<template>
  <section class="imp-panel">
    <div class="panel-title">阻抗控制</div>
    <!-- 类型单选：关节/笛卡尔阻抗，切换重设数组长度 -->
    <div class="row">
      <label><input type="radio" :value="1" v-model="type" @change="onTypeChange" /> 关节阻抗</label>
      <label><input type="radio" :value="2" v-model="type" @change="onTypeChange" /> 笛卡尔阻抗</label>
    </div>
    <!-- K / D 参数输入:K/D 逐轴配对成组卡片(2026-09-04 卡片化) -->
    <div class="kd-grid">
      <div v-for="(_, i) in k" :key="'kd' + i" class="kd-item">
        <span class="lbl">J{{ i + 1 }}</span>
        <input type="number" v-model.number="k[i]" step="1" :disabled="busy" title="刚度 K" />
        <span class="lbl" style="opacity:.6">D</span>
        <input type="number" v-model.number="d[i]" step="0.1" :disabled="busy" title="阻尼 D" />
      </div>
    </div>
    <button class="btn primary full" :disabled="busy" @click="apply">应用（确认）</button>
    <p class="hint">{{ msg || '下发即进入扭矩模式（TORQUE）；退出请切回位置模式' }}</p>

    <!-- 参数说明（2026-09-04 用户口径:高级面板每个模式都要讲清参数怎么设置） -->
    <PanelGuide title="阻抗控制">
      <p class="g-p">阻抗控制 = 给关节/末端一个"虚拟弹簧-阻尼"：K 越大越硬（越贴近目标位置）、D 越大越阻尼（越不易振荡）。用于柔顺装配、协作释放(RELEASE)示教前的柔顺化等场景。</p>
<div class="g-row"><b>关节阻抗</b><span>type=1,对 7 个关节各自施加 K/D;默认 K=200、D=20（计划 §4.3 现场默认）。<b>量纲:</b>K 0~22 N·m/deg、D 0~1(无量纲)——手册 §12.4 关节阻抗参数范围</span></div>
      <div class="g-row"><b>笛卡尔阻抗</b><span>type=2,在末端 6 维施加 K/D;默认 K=1000、D=100,适合末端柔顺接触。<b>量纲:</b>平移 0~12000 N/m、旋转 0~600 N·m/rad、零空间 20~100（手册 §12.4）</span></div>
      <div class="g-row"><b>K（刚度）</b><span>越大越硬、越贴近目标位置。起步建议 50~200:越小越柔顺;装配类任务取低值,轨迹保持取高值</span></div>
      <div class="g-row"><b>D（阻尼）</b><span>越大越不易振荡。经验:K 调大后 D 同步加大,否则末端会振;可按 D≈2√K 的 0.5~0.7 倍估</span></div>
      <ol class="g-steps">
        <li>选择阻抗类型（关节 / 笛卡尔）;</li>
        <li>逐轴填 K/D(或先用默认 200/20 试探);</li>
        <li>点「应用（确认）」→ 二次确认后进入扭矩模式生效;</li>
        <li>退出:切回位置模式即可,阻抗参数不自动清除。</li>
      </ol>
      <p class="g-warn">应用即进入扭矩模式（TORQUE）,机器人会立刻按新参数运动;调试新参数时人员请离开作业空间,从小 K 值开始试。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
/* 2026-09-04 质感升级:类型选择改为芯片单选 + K/D 网格卡片化输入 */
.row { display:flex; gap:6px; margin-bottom:10px; }
.row label { flex:1; display:flex; align-items:center; justify-content:center; gap:5px;
  cursor:pointer; font-size:11px; color:var(--dim);
  border:1px solid rgba(46,230,214,.2); border-radius:7px; padding:6px 4px;
  background:linear-gradient(180deg, rgba(46,230,214,.05), rgba(46,230,214,.01));
  transition:.16s; }
.row label:has(input:checked) { color:#fff; border-color:rgba(46,230,214,.75);
  background:linear-gradient(180deg, rgba(46,230,214,.24), rgba(46,230,214,.1));
  box-shadow:0 0 10px rgba(46,230,214,.22); }
.row input[type=radio] { accent-color:var(--acc); }
/* K/D 七组两列网格:组标签带轴号徽标,输入框聚焦发光 */
.kd-grid { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:10px; }
.kd-item { display:flex; align-items:center; gap:6px;
  border:1px solid rgba(46,230,214,.12); border-radius:7px;
  background:rgba(46,230,214,.03); padding:4px 7px; transition:.16s; }
.kd-item:focus-within { border-color:rgba(46,230,214,.55);
  box-shadow:0 0 8px rgba(46,230,214,.18); background:rgba(46,230,214,.06); }
.lbl { font-size:10px; color:var(--acc); font-family:var(--m); min-width:20px; }
.kd-grid input { width:100%; min-width:0; background:transparent; border:none;
  color:var(--tx); font-family:var(--m); font-size:12px; padding:2px 0; outline:none; }
/* 数字输入框去掉原生上下箭头(与玻璃卡片风格冲突),步进由键盘承担 */
.kd-grid input::-webkit-outer-spin-button,
.kd-grid input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.kd-grid input[type=number] { -moz-appearance:textfield; appearance:textfield; }
.hint { font-size:9.5px; color:var(--dim); line-height:1.55; margin-top:8px;
  padding:6px 8px; border-radius:6px; background:rgba(251,191,36,.05);
  border:1px solid rgba(251,191,36,.14); color:rgba(251,191,36,.8); }
</style>
