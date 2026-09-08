/**
 * @file    useCommandBus.ts
 * @brief   Web 命令唯一出口：服务门禁出口 sendCommand + topic 流出口 sendStream + 拖动流
 * @author Csihan
 * @date    2026-09-02
 *
 * 设计（App 拆分，2026-09-02）：
 *   - 从 App.vue 剥离「命令协议出口」三函数，行为原样迁移；
 *   - 门禁：SIMULATION_ONLY（真机短路）+ connected（rosbridge 未连接短路）由调用方注入；
 *   - message_id 连续性：msgId 计数器收敛在本模块（service 与 stream 共用同一计数，
 *     comms 按 caller_id 校验连续性，缺号/重号会被拒绝）；
 *   - 调用约定不变：会引发运动的命令走 sendCommand（请求-响应）；
 *     连续型命令（拖动流/滑条快调）走 sendStream（topic 流 fire-and-forget）。
 */

// rosbridge 服务按 caller_id 维护 message_id 连续性；
// 刷新页面必须换 caller，否则 message_id 从 1 重发会被服务端拒绝。
// 使用 base36 时间戳让 caller_id 单调递增且跨刷新唯一（同一会话内稳定即可）。
const CALLER_ID = `web_dashboard_${Date.now().toString(36)}`
import type { Ref } from 'vue'
import type { JointDragCommand } from './useRobot3D'

/** 服务门禁与 topic 流门禁（App 注入：SIMULATION_ONLY + rosbridge connected）。 */
export interface CommandBusDeps {
  /** 真机门禁：false=全部命令短路（真机命令未授权）。 */
  simulationOnly: () => boolean
  /** rosbridge 连接状态（useRos 的 connected ref）。 */
  connected: Ref<boolean>
  /** rosbridge 服务调用（请求-响应）。 */
  callService: (service: string, type: string, payload: any) => Promise<any>
  /** topic 发布（fire-and-forget）。 */
  publish: (topic: string, type: string, payload: any) => void
}

/** 命令总线控制器。 */
export interface CommandBus {
  sendCommand(type: string, content: any): Promise<any>
  sendStream(type: string, content: any): void
  streamDragCommand(command: JointDragCommand): void
}

let msgId = 0

/** 创建命令总线（原 App.vue 对应逻辑原样迁移）。 */
export function useCommandBus(deps: CommandBusDeps): CommandBus {
  const { connected, callService, publish } = deps

/**
 * 命令唯一出口：Mock 硬门禁 + 连续 message_id + 统一 rosbridge 服务调用。
 *
 * @param type    命令类型字符串（与 comms 的 human_extern_cmd.type 对齐，如 'manipulators_control'）。
 * @param content 命令负载对象（结构由 comms 按 type 分发解析）。
 * @returns       rosbridge 服务调用结果 `{ content, values }`；不满足前置时返回带 ret:false 的占位。
 *
 * 调用约定：
 *   - 所有会引发运动的命令必须走这里，便于将来切换真机时统一加授权。
 *   - 连续型命令（拖动流、滑条快调）走 sendStream() → topic 流，不要走这里。
 */
async function sendCommand(type: string, content: any) {
  // 第 1 道门禁：真机模式下任何命令直接短路返回（直到有授权流程上线）。
  if (!deps.simulationOnly()) return { content: { ret: false }, values: '真机命令未授权' }
  // 第 2 道门禁：rosbridge 未连接时也不能下发（避免离线时命令堆积后到达导致错位）。
  if (!connected.value) return { content: { ret: false }, values: 'rosbridge 未连接' }
  // 自增命令序号：comms 端按 caller_id 校验连续性，缺号/重号都会被拒绝。
  msgId += 1
  // 协议组装：header 含 message_id + caller_id + type 三元组；content 由 comms 按 type 分发。
  const cmdJson = JSON.stringify({
    header: { message_id: msgId, caller_id: CALLER_ID, type },
    content,
  })
  // 走统一服务 /robot/human_extern_cmd（service = 请求-响应，便于上层 await 结果）。
  return callService('/robot/human_extern_cmd', 'robot_core_msgs/human_extern_cmd', { cmd_json: cmdJson })
}

/** 连续型命令统一出口（2026-08-30 用户第八轮）：走 topic 流 fire-and-forget——
 *  service 出站在长会话下会半开丢命令（仅首条透传），拖动流已验证 topic 通道可靠；
 *  onCmdStream 与 service 共用同一 processCmdJson 分发，功能完全等价。 */
function sendStream(type: string, content: any) {
  if (!deps.simulationOnly()) return
  if (!connected.value) return
  msgId += 1
  const cmdJson = JSON.stringify({
    header: { message_id: msgId, caller_id: CALLER_ID, type },
    content,
  })
  publish('/robot/human_extern_cmd_stream', 'std_msgs/String', { data: cmdJson })
}

/**
 * 拖动 topic 流（2026-08-29）：3D 关节拖动的连续目标改走话题发布（30Hz），
 * 不再走 rosbridge service call——服务调用是请求-响应模式，往返延迟大且串行，
 * 是此前拖动"不跟手"的最大瓶颈。协议体与 human_extern_cmd 服务完全一致，
 * message_id/caller_id 沿用同一计数器保证 comms 侧连续性校验通过。
 */
function streamDragCommand(command: JointDragCommand) {
  if (!connected.value) return
  msgId += 1
  const cmdJson = JSON.stringify({
    header: { message_id: msgId, caller_id: CALLER_ID, type: 'manipulators_control' },
    content: {
      arm: command.arm, control_mode: 1,
      joint_angles: command.jointAnglesRad, velocity_pct: 10, acceleration_pct: 10,
    },
  })
  publish('/robot/human_extern_cmd_stream', 'std_msgs/String', { data: cmdJson })
}

  return { sendCommand, sendStream, streamDragCommand }
}
