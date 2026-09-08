<script setup lang="ts">
/**
 * @file    EndToolPanel.vue
 * @brief   末端通信面板：经 CANFD/COM1/COM2 与末端工具（夹爪/传感器）收发数据
 * @author Csihan
 * @date    2026-09-03
 *
 * 链路：sendCommand('end_tool') → comms 协议 V1.0.9 → /arm/end_tool → SDK SetChData/GetChData。
 * 使用逻辑（SDK 文档 §9）：清缓存 → 发数据 → 读数据，或 清缓存 → 读数据 → 发数据 → 读数据。
 */
import { ref } from 'vue'
import type { ArmPlanController } from '../composables/useArmPlan'
// 通用「参数说明」折叠块(2026-09-04)
import PanelGuide from './PanelGuide.vue'

const props = defineProps<{ plan: ArmPlanController; busy: boolean }>()

const armId = ref<1 | 2>(1)
const ch = ref<1 | 2 | 3>(1)
const msg = ref('')

/** 发送数据（hex 字符串，空格/逗号分隔，≤256 字节） */
const hexInput = ref('01 03 00 00 00 02 C4 0B')
/** 接收结果显示 */
const recvResult = ref('')

const sideName = () => (armId.value === 1 ? '左臂' : '右臂')
const chName = () => (ch.value === 1 ? 'CANFD' : ch.value === 2 ? 'COM1' : 'COM2')

/** hex 字符串 → 字节数组（容忍空格/逗号/0x 前缀） */
function parseHex(s: string): number[] {
  const clean = s.replace(/0x/gi, '').replace(/[,\s]+/g, ' ')
  const parts = clean.trim().split(/\s+/).filter(Boolean)
  const bytes: number[] = []
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(p)) return []
    bytes.push(parseInt(p, 16))
  }
  return bytes.length > 256 ? bytes.slice(0, 256) : bytes
}

/** 字节数组 → hex 字符串 */
function fmtHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')
}

/** 发送（action=1） */
async function send() {
  const data = parseHex(hexInput.value)
  if (!data.length) { msg.value = 'hex 格式错误或为空'; return }
  if (!window.confirm(`向 ${sideName()} 的 ${chName()} 发送 ${data.length} 字节？`)) return
  const ok = await props.plan.endToolSend({ arm: armId.value, action: 1, ch: ch.value, data })
  msg.value = ok ? `${props.plan.message.value}（${data.length} 字节）` : props.plan.lastError.value
}

/** 接收（action=2）：返回字节数组 + 通道 */
async function recv() {
  const res = await props.plan.endToolRecv(armId.value, ch.value)
  if (res) {
    recvResult.value = res.data.length ? fmtHex(res.data) : '（空）'
    msg.value = props.plan.message.value
  } else {
    msg.value = props.plan.lastError.value
  }
}

/** 清缓存（action=3） */
async function clear() {
  const ok = await props.plan.endToolClear(armId.value, ch.value)
  msg.value = ok ? props.plan.message.value : props.plan.lastError.value
}
</script>

<template>
  <section class="et-panel">
    <div class="panel-title">末端通信</div>

    <div class="row">
      <label><input type="radio" :value="1" v-model="armId" /> 左臂</label>
      <label><input type="radio" :value="2" v-model="armId" /> 右臂</label>
    </div>
    <div class="row">
      <label><input type="radio" :value="1" v-model="ch" /> CANFD</label>
      <label><input type="radio" :value="2" v-model="ch" /> COM1</label>
      <label><input type="radio" :value="3" v-model="ch" /> COM2</label>
    </div>

    <div class="lbl-row"><span>发送数据（hex，≤256 字节）</span></div>
    <textarea v-model="hexInput" rows="2" :disabled="busy" spellcheck="false"></textarea>

    <div class="btn-row">
      <button class="btn primary" :disabled="busy" @click="send">发送</button>
      <button class="btn" :disabled="busy" @click="recv">接收</button>
      <button class="btn danger" :disabled="busy" @click="clear">清缓存</button>
    </div>
    <p v-if="recvResult" class="out">接收：{{ recvResult }}</p>
    <p class="hint">{{ msg || '使用逻辑：清缓存 → 发数据 → 读数据（建议先清缓存再收发）' }}</p>

    <!-- 参数说明（2026-09-04） -->
    <PanelGuide title="末端通信">
      <p class="g-p">末端通信 = 通过臂的控制器给末端工具(夹爪控制器/传感器/吸盘阀等)透传自定义协议帧,调试第三方末端设备用。</p>
      <div class="g-row"><b>CANFD / COM1 / COM2</b><span>通信通道:CANFD=末端 CAN 总线(常见),COM1/COM2=串口;与末端设备的接线/协议对应,以设备手册为准</span></div>
      <div class="g-row"><b>发送数据</b><span>十六进制字节流,不带 0x 前缀、空格可有可无,如 01 06 00 01 00 01;单帧 ≤256 字节</span></div>
      <div class="g-row"><b>发送 / 接收</b><span>发送=把帧打到通道;接收=读回该通道缓存里设备应答(原样 hex 显示)</span></div>
      <div class="g-row"><b>清缓存</b><span>清空接收缓存再收发,避免旧应答混入——所以推荐"清缓存→发→读"顺序</span></div>
      <ol class="g-steps">
        <li>选臂、选通道(与设备接线一致);</li>
        <li>「清缓存」→ 填 hex 帧 → 「发送」;</li>
        <li>「接收」读应答;对照设备协议手册解析;</li>
        <li>联调异常时先「清缓存」再重试,排除残留帧干扰。</li>
      </ol>
      <p class="g-warn">发送的帧直达末端设备,协议内容错误可能让夹爪误动作——首次下发未知设备协议前,先与设备方核对帧格式。</p>
    </PanelGuide>
  </section>
</template>

<style scoped>
.row { display:flex; gap:12px; margin-bottom:6px; font-size:10px; color:var(--tx); }
.row label { display:flex; align-items:center; gap:4px; cursor:pointer; }
.lbl-row { font-size:9px; color:var(--dim); margin:4px 0; }
textarea { width:100%; background:rgba(0,0,0,.35); border:1px solid rgba(46,230,214,.2);
  border-radius:6px; color:var(--tx); font-family:var(--m); font-size:10px; padding:5px;
  resize:vertical; min-height:34px; box-sizing:border-box; }
.btn-row { display:flex; gap:8px; margin-top:6px; }
.btn-row .btn { flex:1; }
.out { font-size:9px; color:var(--acc); font-family:var(--m); line-height:1.6; margin-top:6px; word-break:break-all; }
.hint { font-size:9px; color:var(--dim); line-height:1.5; margin-top:6px; }
</style>