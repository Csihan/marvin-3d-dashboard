<script setup lang="ts">
/**
 * @file    ParamPanel.vue
 * @brief   参数/维护面板：robot.ini 读写、伺服复位、日志下载
 * @author Csihan
 * @date    2026-08-31
 *
 * 链路（计划 §6）：para_set/para_get/para_save/servo_reset/log_download →
 * comms 新分发分支 → /arm/* 服务 → SDK。
 * 参数读结果与日志内容经 /robot/status（module=arm_para / arm_log）异步回传，
 * 本面板订阅 robotStore.paraRead / logDownload 展示；日志触发浏览器 Blob 下载。
 * 安全：伺服复位二次确认 + 红字提示（复位会短暂断使能）。
 */
import { ref, watch } from 'vue'
import { robotStore } from '../composables/useRobotStatus'
import type { TeachController } from '../composables/useTeach'
// 通用「参数说明」折叠块(2026-09-04)
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ teach: TeachController; busy: boolean }>()

/** 当前选中臂的中文名（左臂/右臂） */
const sideName = () => props.teach.side.value === 'arm_L' ? '左臂' : '右臂'

// ══════════════════════════════════════════════════════════════
// robot.ini 参数读写
// ══════════════════════════════════════════════════════════════

/** 参数名（如 MAX_SPEED） */
const paraName = ref('')
/** 参数类型：1=int / 2=float */
const paraType = ref<1 | 2>(1)
/** 要写入的参数值 */
const paraValue = ref(0)
/** 操作结果消息 */
const paraMsg = ref('')
/** 读取回显值（由 /robot/status 异步回传） */
const readValue = ref<string | null>(null)

/**
 * 写入 robot.ini 参数：二次确认 → teach.setPara → 等待回执。
 * 写入后参数立即生效（SDK 内存），但需 savePara 才持久化到文件。
 */
async function writePara() {
  if (!paraName.value.trim()) { paraMsg.value = '请输入参数名'; return }
  if (!window.confirm(`写入 robot.ini 参数 ${paraName.value}（${paraType.value === 1 ? 'int' : 'float'}）= ${paraValue.value}？`)) return
  const ok = await props.teach.setPara(paraName.value, paraType.value, paraValue.value)
  paraMsg.value = ok ? props.teach.message.value : props.teach.lastError.value
}

/**
 * 读取 robot.ini 参数：触发异步读取，结果经 /robot/status（module=arm_para）回传。
 * 读取是异步的（SDK 跨进程），结果由下方 watch(robotStore.paraRead) 接收并展示。
 */
async function readPara() {
  if (!paraName.value.trim()) { paraMsg.value = '请输入参数名'; return }
  readValue.value = null
  const ok = await props.teach.getPara(paraName.value, paraType.value)
  paraMsg.value = ok ? '参数读取已受理，等待回执…' : props.teach.lastError.value
}

// 监听参数读回执（module=arm_para）到达后展示
watch(() => robotStore.paraRead?.ts, () => {
  const r = robotStore.paraRead
  if (!r || r.paraName !== paraName.value) return  // 只显示当前查询的参数
  readValue.value = `${r.value}${r.type === 1 ? '' : ' (float)'} · sdk_ret=${r.sdkRet}`
  paraMsg.value = `读取成功：${r.paraName} = ${r.value}`
})

/**
 * 保存当前参数到 robot.ini 文件（持久化）：二次确认 → teach.savePara。
 * 保存后参数在节点重启后仍然生效。
 */
async function savePara() {
  if (!window.confirm('保存当前参数到 robot.ini？')) return
  const ok = await props.teach.savePara()
  paraMsg.value = ok ? props.teach.message.value : props.teach.lastError.value
}

// ══════════════════════════════════════════════════════════════
// 伺服复位（危险操作，二次确认 + 红字提示）
// ══════════════════════════════════════════════════════════════

/** 复位轴选择：-1=全部关节 / 0~6=单轴（J1~J7） */
const axis = ref(-1)
/** 伺服复位结果消息 */
const servoMsg = ref('')

/**
 * 执行伺服软复位：二次确认 → teach.servoReset。
 * 复位会短暂断使能，臂可能瞬间失去力矩——必须确认现场安全。
 */
async function servoReset() {
  const axisTxt = axis.value < 0 ? '全部关节' : `J${axis.value + 1}`
  if (!window.confirm(`伺服软复位 ${sideName()} ${axisTxt}？复位会短暂断使能，请确认现场安全。`)) return
  const ok = await props.teach.servoReset(props.teach.side.value, axis.value)
  servoMsg.value = ok ? props.teach.message.value : props.teach.lastError.value
}

// ══════════════════════════════════════════════════════════════
// 日志下载（触发浏览器 Blob 下载）
// ══════════════════════════════════════════════════════════════

/** 日志保存路径（机器人后端侧路径，非浏览器本机路径） */
const logPath = ref('/tmp/robot_logs/arm_log.txt')
/** 日志操作结果消息 */
const logMsg = ref('')
/** 日志是否已就绪（回执到达后为 true） */
const logReady = ref(false)

/**
 * 触发日志下载：下发 log_download 命令 → 等待 /robot/status（module=arm_log）回执。
 * 日志内容到达后触发浏览器 Blob 下载（保存为 .log 文件）。
 */
async function downloadLog() {
  logReady.value = false
  const ok = await props.teach.downloadLog(logPath.value)
  logMsg.value = ok ? '日志下载已受理，等待回执…' : props.teach.lastError.value
}

// 监听日志回执（module=arm_log）到达后触发浏览器 Blob 下载
watch(() => robotStore.logDownload?.ts, () => {
  const r = robotStore.logDownload
  if (!r) return
  logReady.value = true
  if (r.tooLarge || !r.data) {
    // 日志过大或仅回传路径（后端侧文件）：提示用户到机器人主机侧取走
    logMsg.value = `日志过大或仅回传路径：${r.outPath}（请到机器人主机侧取走）`
    return
  }
  // 日志内容可内联：触发浏览器保存 .log 文件（Blob + 动态 a 标签点击）
  const blob = new Blob([r.data], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `arm_log_${Date.now()}.log`
  a.click()
  URL.revokeObjectURL(url)
  logMsg.value = `日志已保存（${r.outPath}）`
})
</script>

<template>
  <!-- 参数/维护面板：robot.ini 读写 + 伺服复位 + 日志下载 -->
  <section class="param-panel">
    <!-- 面板标题 -->
    <div class="panel-title">参数 / 维护</div>

    <!-- ═══ robot.ini 参数读写区 ═══ -->
    <div class="sub">robot.ini 参数</div>
    <!-- 参数名输入（如 MAX_SPEED） -->
    <label class="row"><span>参数名</span><input v-model="paraName" :disabled="busy" placeholder="如 MAX_SPEED" /></label>
    <!-- 参数类型选择：int / float -->
    <label class="row"><span>类型</span>
      <select v-model="paraType" :disabled="busy"><option :value="1">int</option><option :value="2">float</option></select>
    </label>
    <!-- 要写入的参数值 -->
    <label class="row"><span>值</span><input type="number" v-model.number="paraValue" step="any" :disabled="busy" /></label>
    <!-- 操作按钮：写参数 / 读参数 / 保存到文件 -->
    <div class="btn-row">
      <button class="btn" :disabled="busy" @click="writePara">写参数</button>
      <button class="btn" :disabled="busy" @click="readPara">读参数</button>
      <button class="btn" :disabled="busy" @click="savePara">保存 robot.ini</button>
    </div>
    <!-- 读取回显值（异步回执到达后显示） -->
    <p v-if="readValue" class="read">{{ readValue }}</p>
    <!-- 操作结果消息 -->
    <p class="hint">{{ paraMsg }}</p>

    <!-- ═══ 伺服复位区（危险操作，红字警告）═══ -->
    <div class="sub danger">伺服复位（危险操作）</div>
    <!-- 复位轴选择：全部关节 / 单轴 J1~J7 -->
    <label class="row"><span>轴</span>
      <select v-model="axis" :disabled="busy">
        <option :value="-1">全部关节</option>
        <option v-for="i in 7" :key="i" :value="i - 1">J{{ i }}</option>
      </select>
    </label>
    <!-- 复位按钮（二次确认，复位会短暂断使能） -->
    <button class="btn danger full" :disabled="busy" @click="servoReset">伺服复位（二次确认）</button>
    <p class="hint">{{ servoMsg }}</p>

    <!-- ═══ 日志下载区 ═══ -->
    <div class="sub">日志下载</div>
    <!-- 日志保存路径（机器人后端侧路径，非浏览器本机路径） -->
    <label class="row"><span>保存路径</span><input v-model="logPath" :disabled="busy" /></label>
    <!-- 下载按钮：触发异步下载，结果经 Blob 保存为 .log 文件 -->
    <button class="btn primary full" :disabled="busy" @click="downloadLog">下载日志</button>
    <p class="hint">{{ logMsg }}</p>

    <!-- 参数说明（2026-09-04） -->
    <PanelGuide title="参数 / 维护">
      <p class="g-p">本页是维护级操作:robot.ini 参数读写、伺服复位、日志下载。日常作业不需要进来。</p>
      <div class="g-row"><b>参数名</b><span>robot.ini 中的键名,区分大小写,如 MAX_SPEED;不知道键名先「读参数」试一个已知的</span></div>
      <div class="g-row"><b>类型</b><span>int=整型、float=浮点;类型选错写入值会被截断或拒绝,以 robot.ini 原类型为准</span></div>
      <div class="g-row"><b>写/读/保存</b><span>写参数=改运行时值(断电丢);保存 robot.ini=把运行时值固化到文件(断电不丢);改完先试运行,稳定再保存</span></div>
      <div class="g-row"><b>伺服复位</b><span>对选中的轴(或全部)做故障清除+重新使能,过程中臂会短暂失力;仅在上报故障码且原因已排除后使用</span></div>
      <div class="g-row"><b>日志下载</b><span>填 SDK 侧保存路径(目录需已存在),下载后按 Blob 存 .log;报障时先下日志再沟通</span></div>
      <ol class="g-steps">
        <li>改参数:填参数名/类型/值 → 写参数 → 观察行为 → 稳定后保存 robot.ini;</li>
        <li>伺服复位:确认故障原因已排除 → 选轴(拿不准选全部) → 点按钮二次确认;</li>
        <li>日志:填路径 → 下载 → 文件在浏览器下载目录。</li>
      </ol>
      <p class="g-warn">伺服复位瞬间失力,负载未固定时臂可能下坠——执行前确保作业空间无人、负载已卸或已支撑。写错参数值可能导致过冲/超限,不确定的键名不要写。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
.sub { font-size:9px; color:var(--acc); margin:8px 0 4px; }
.sub.danger { color:var(--red); }
.row { display:flex; align-items:center; gap:6px; margin-bottom:4px; }
.row span { font-size:9px; color:var(--dim); white-space:nowrap; }
.row input, .row select { width:100%; min-width:0; }
.btn-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:4px; margin-top:4px; }
.hint { font-size:9px; color:var(--dim); line-height:1.4; margin:4px 0 0; }
.read { font-size:10px; color:var(--grn); font-family:var(--m); margin-top:4px; }
</style>
