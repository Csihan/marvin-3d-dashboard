<script setup lang="ts">
/**
 * @file    PvtPanel.vue
 * @brief   PVT 上传 / 轨迹采集（gather）/ 工具参数 面板
 * @author Csihan
 * @date    2026-08-31
 *
 * 链路（计划 §5）：Web sendCommand('pvt_upload'/'gather_control'/'tool_set') →
 * comms 新分发分支 → /arm/send_pvt、/arm/gather、/arm/set_tool → SDK。
 * PVT 文件路径必须是机器人后端运行环境可访问的绝对路径。
 * 采集目标 ID 默认勾选反馈电流 40-46 + 反馈扭矩 50-56（FxRtCSDef.h 注释口径）。
 *
 * 功能分区：
 *   1. PVT 上传：指定文件路径 + 段号 → 上传到 SDK 执行；
 *   2. 数据采集：选择采集目标 ID + 记录数 + CSV 路径 → 开始/停止/保存；
 *   3. 工具参数：左/右臂独立切换 + kine[6]/dyn[10] 读取/下发/保存。
 */
import { onMounted, ref, watch } from 'vue'
import type { TeachController } from '../composables/useTeach'
// 通用「参数说明」折叠块(2026-09-04)
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ teach: TeachController; busy: boolean }>()

/** 当前选中臂的中文名（左臂/右臂） */
const sideName = () => props.teach.side.value === 'arm_L' ? '左臂' : '右臂'

// ══════════════════════════════════════════════════════════════
// PVT 上传
// ══════════════════════════════════════════════════════════════

/** PVT 文件路径（后端侧绝对路径） */
const filePath = ref('/tmp/robot_pvt/pvt_1.txt')
/** PVT 段号（从文件中选择第几段执行） */
const serial = ref(1)
/** 操作结果消息 */
const pvtMsg = ref('')

/**
 * 上传 PVT 文件：二次确认 → teach.uploadPvt → SDK 执行。
 * 文件路径必须是 SDK 运行环境可访问的绝对路径。
 */
async function uploadPvt() {
  if (!filePath.value.trim()) { pvtMsg.value = '请输入 PVT 文件路径'; return }
  if (!window.confirm(`向 ${sideName()} 上传 PVT 文件？路径（SDK 侧）：${filePath.value}`)) return
  const ok = await props.teach.uploadPvt(props.teach.side.value, filePath.value, serial.value)
  pvtMsg.value = ok ? props.teach.message.value : props.teach.lastError.value
}

// ══════════════════════════════════════════════════════════════
// 数据采集（gather）
// ══════════════════════════════════════════════════════════════

/** 采集目标 ID 列表（默认勾选：40-46 反馈电流 + 50-56 反馈扭矩） */
const targets = ref<number[]>([40,41,42,43,44,45,46,50,51,52,53,54,55,56])
/** 采集记录数（采样点数量） */
const recordNum = ref(1000)
/** CSV 保存路径（SDK 侧路径） */
const savePath = ref('/tmp/robot_gather/gather.csv')
/** 操作结果消息 */
const gatherMsg = ref('')

/**
 * 执行采集操作：action 1=开始采集 / 2=停止 / 3=保存 CSV。
 * @param action  操作类型（1=开始 / 2=停止 / 3=保存）
 */
async function gather(action: 1 | 2 | 3) {
  const ok = await props.teach.gatherControl(
    props.teach.side.value, action, targets.value, recordNum.value, savePath.value)
  gatherMsg.value = ok ? props.teach.message.value : props.teach.lastError.value
}

// ══════════════════════════════════════════════════════════════
// 工具参数（kine[6] + dyn[10]）——左/右臂独立切换
// ══════════════════════════════════════════════════════════════

/** 当前操作的臂（独立于 PVT/采集的示教侧，读/下发/保存都作用于当前选中臂） */
const toolSide = ref<'arm_L' | 'arm_R'>('arm_L')
/** 当前操作臂的中文名 */
const toolSideName = () => toolSide.value === 'arm_L' ? '左臂' : '右臂'
/** 运动学参数 kine[6]（工具坐标系偏移） */
const kine = ref<number[]>(Array(6).fill(0))
/** 动力学参数 dyn[10]（惯量/摩擦补偿） */
const dyn = ref<number[]>(Array(10).fill(0))
/** 操作结果消息 */
const toolMsg = ref('')

/**
 * 读取当前生效的工具参数回填输入框。
 * 启动时=yaml 值；运行期下发/保存成功后=最新值。
 */
async function loadTool() {
  const got = await props.teach.getToolParams(toolSide.value)
  if (got) {
    kine.value = [...got.kine]
    dyn.value = [...got.dyn]
  }
  toolMsg.value = got ? props.teach.message.value : props.teach.lastError.value
}

/**
 * 仅下发 SDK（立即生效，不写 yaml；节点重启后失效）。
 * 二次确认后调用 teach.setToolParams。
 */
async function sendTool() {
  if (!window.confirm(`向 ${toolSideName()} 下发工具参数（kine[6]+dyn[10]，仅生效不保存）？`)) return
  const ok = await props.teach.setToolParams(toolSide.value, [...kine.value], [...dyn.value])
  toolMsg.value = ok ? props.teach.message.value : props.teach.lastError.value
}

/**
 * 保存：SDK 立即生效 + 回写 arm_L/arm_R.yaml（重启节点后仍生效）。
 * 二次确认后调用 teach.saveToolParams。
 */
async function saveTool() {
  if (!window.confirm(`保存 ${toolSideName()} 工具参数？SDK 立即生效并写回配置文件。`)) return
  const ok = await props.teach.saveToolParams(toolSide.value, [...kine.value], [...dyn.value])
  toolMsg.value = ok ? props.teach.message.value : props.teach.lastError.value
}

// 切臂即回读该臂当前值——避免把 A 臂参数误存到 B 臂
watch(toolSide, () => { void loadTool() })
// 挂载即回读一次默认臂（未连接时只影响 hint 提示，无副作用）
onMounted(() => { void loadTool() })
</script>

<template>
  <!-- PVT / 采集 / 工具参数面板 -->
  <section class="pvt-panel">
    <!-- 面板标题 -->
    <div class="panel-title">PVT / 采集</div>

    <!-- ═══ PVT 轨迹上传区 ═══ -->
    <div class="sub">PVT 轨迹上传</div>
    <!-- PVT 文件路径（SDK 侧绝对路径） -->
    <label class="row"><span>文件路径</span><input v-model="filePath" :disabled="busy" /></label>
    <!-- 段号（从文件中选择第几段执行） -->
    <label class="row"><span>段号</span><input type="number" v-model.number="serial" step="1" :disabled="busy" /></label>
    <!-- 上传按钮（二次确认后执行） -->
    <button class="btn primary full" :disabled="busy" @click="uploadPvt">上传 PVT（确认）</button>
    <p class="hint">{{ pvtMsg }}</p>

    <!-- ═══ 数据采集区 ═══ -->
    <div class="sub">数据采集 gather</div>
    <!-- 采集目标 ID 选择（多选复选框，默认勾选电流+扭矩） -->
    <div class="tg">
      <label v-for="t in targets" :key="t"><input type="checkbox" :value="t" v-model="targets" />{{ t }}</label>
    </div>
    <!-- 采样记录数 + CSV 保存路径 -->
    <label class="row"><span>记录数</span><input type="number" v-model.number="recordNum" step="1" :disabled="busy" /></label>
    <label class="row"><span>CSV 路径</span><input v-model="savePath" :disabled="busy" /></label>
    <!-- 采集操作按钮：开始(1) / 停止(2) / 保存CSV(3) -->
    <div class="btn-row">
      <button class="btn" :disabled="busy" @click="gather(1)">开始采集</button>
      <button class="btn" :disabled="busy" @click="gather(2)">停止</button>
      <button class="btn" :disabled="busy" @click="gather(3)">存 CSV</button>
    </div>
    <p class="hint">{{ gatherMsg }}</p>

    <!-- ═══ 工具参数区（kine[6] + dyn[10]）═══ -->
    <div class="sub">工具参数（kine[6] + dyn[10]）</div>
    <!-- 臂选择：左/右臂独立切换（不随 PVT/采集的示教侧走） -->
    <div class="tg">
      <label><input type="radio" value="arm_L" v-model="toolSide" :disabled="busy" />左臂</label>
      <label><input type="radio" value="arm_R" v-model="toolSide" :disabled="busy" />右臂</label>
    </div>
    <!-- kine[6] + dyn[10] 参数输入网格（6+10=16 个输入框） -->
    <div class="kine-grid">
      <template v-for="(_, i) in kine" :key="'k' + i">
        <span class="lbl">K{{ i + 1 }}</span>
        <input type="number" v-model.number="kine[i]" step="0.1" :disabled="busy" />
      </template>
      <template v-for="(_, i) in dyn" :key="'d' + i">
        <span class="lbl">D{{ i + 1 }}</span>
        <input type="number" v-model.number="dyn[i]" step="0.1" :disabled="busy" />
      </template>
    </div>
    <!-- 操作按钮：读取当前值 / 仅下发（不保存） / 保存生效（写回 yaml） -->
    <div class="btn-row">
      <button class="btn" :disabled="busy" @click="loadTool">读取当前</button>
      <button class="btn" :disabled="busy" @click="sendTool">仅下发</button>
      <button class="btn primary" :disabled="busy" @click="saveTool">保存生效</button>
    </div>
    <p class="hint">{{ toolMsg }}</p>

    <!-- 参数说明（2026-09-04） -->
    <PanelGuide title="PVT / 采集">
      <p class="g-p">本页三块功能互相独立:PVT 轨迹上传(执行离线轨迹)、数据采集(录制运行数据)、工具参数(标定工具坐标/动力学)。</p>
      <div class="g-row"><b>文件路径</b><span>后端(机器人主机)能看到的绝对路径,如 /home/robot/pvt/demo.csv;不是浏览器本机路径</span></div>
      <div class="g-row"><b>段号</b><span>一个 PVT 文件可含多段轨迹,从 1 开始;执行文件里的第几段就填几</span></div>
      <div class="g-row"><b>采集目标</b><span>勾选要录的量:电流/扭矩/位置等;默认勾电流+扭矩(排查负载问题最常用)</span></div>
      <div class="g-row"><b>记录数</b><span>采集缓存条数上限,到数自动停;采样频率由后端固定,数据量≈记录数×勾选维度</span></div>
      <div class="g-row"><b>CSV 路径</b><span>采集结果在 SDK 侧的落盘路径(目录需已存在),点「存 CSV」才写文件</span></div>
      <div class="g-row"><b>kine[6]</b><span>工具坐标 6 参:依次 K1~K3=TCP 平移偏移(mm) X/Y/Z,K4~K6=TCP 姿态角(deg) ZYX;换夹爪/换工具后必须重标</span></div>
      <div class="g-row"><b>dyn[10]</b><span>动力学 10 参:质量+质心+惯量等,用于力/阻抗补偿;保持「读取当前」值即可,勿凭感觉填</span></div>
      <ol class="g-steps">
        <li>PVT:填路径与段号 → 上传(二次确认) → 机器人按轨迹运动;</li>
        <li>采集:勾目标 → 开始采集 → 触发动作 → 停止 → 存 CSV;</li>
        <li>工具参数:切臂 → 「读取当前」回显 → 改完「仅下发」验证 → 确认无误再「保存生效」(写入 yaml,断电不丢)。</li>
      </ol>
      <p class="g-warn">「保存生效」会写后端 yaml 持久化;错误的 TCP 偏移会让所有笛卡尔目标整体偏移,修改前先「读取当前」备份原值。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
.sub { font-size:9px; color:var(--acc); margin:8px 0 4px; }
.row { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
.row span { font-size:9px; color:var(--dim); white-space:nowrap; }
.row input { width:100%; min-width:0; }
.btn-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px; margin-top:4px; }
.hint { font-size:9px; color:var(--dim); line-height:1.4; margin:4px 0 0; }
.tg { display:flex; flex-wrap:wrap; gap:3px 8px; margin-bottom:4px; }
.tg label { font-size:9px; color:var(--tx); display:flex; align-items:center; gap:2px; }
.kine-grid { display:grid; grid-template-columns:24px 1fr; gap:3px 8px; align-items:center; margin-bottom:6px; }
.lbl { font-size:9px; color:var(--dim); text-align:right; font-family:var(--m); }
.kine-grid input { width:100%; min-width:0; }
</style>
