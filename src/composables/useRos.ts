/**
 * @file    useRos.ts
 * @brief   rosbridge WebSocket 连接 + 自动重连 + 数据流看门狗 + 话题订阅/服务调用
 * @author Csihan
 * @date    2026-08-28
 *
 * 2026-09-03：连接地址与全部自愈参数改由 dashboard.yaml（ros_bridge 段）配置，
 * 支撑局域网/分机部署"改配置不改代码"；默认值与原硬编码完全一致，配置缺失零影响。
 *
 * 2026-08-30（E2E 自动测试发现）：后端栈重启后 TCP 重连"成功"但链路半开——
 * rosbridge 已登记订阅、connected=true，页面却收不到任何入站数据（界面永久假活，
 * 命令仅首条透传）。新增数据流看门狗：12s 无任何入站 → 主动断开交由重连逻辑自愈。
 */
import { ref, onUnmounted } from 'vue'
// @ts-ignore roslib types incomplete
import * as ROSLIB from 'roslib'
const R: any = ROSLIB
// 2026-09-03：运行配置（dashboard.yaml）——连接地址与自愈参数的唯一来源
import { getDashboardConfig, resolveRosBridgeUrl } from '../config/dashboardConfig'

const connected = ref(false)
let ros: any = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectDelay = 0 // 当前重连延迟（useRos() 内按配置初始化；0=尚未开始）

// —— 订阅注册表（2026-09-06 缺陷修复：重连后订阅重放）——
// 根因：App 只在 onMounted 时调用一次 subscribe()，而 connect() 重连会生成**新的
// ros 实例**；旧 Topic 绑定在旧 socket 上，重连后 /robot/internal/arm/joint_states
// 等话题静默——页面显示「已连接」但 3D 模型与 HUD 全部冻结（数据-渲染不同步）。
// 修复：subscribe() 时登记 {name,type,cb}；每次 connection 建立后在新 ros 实例上
// 全量重建 Topic 并重新 subscribe，业务回调无需感知重连。
interface SubEntry { name: string; type: string; cb: (msg: any) => void }
const subRegistry: SubEntry[] = []
/** 在当前 ros 实例上重建单个订阅（连接建立/重连后调用）。 */
function attachSubscription(entry: SubEntry): void {
  if (!ros) return
  const opts: any = { ros, name: entry.name }
  if (entry.type) opts.messageType = entry.type
  const topic = new R.Topic(opts)
  // 包装入站标记：任何应用话题有数据 = 连接真实存活（看门狗的活性依据）
  topic.subscribe((msg: any) => { noteInbound(); entry.cb(msg) })
}

// —— 数据流看门狗（活性依据 = 应用层入站数据，而非 TCP 状态）——
// 判定阈值 2026-09-03 起由 dashboard.yaml ros_bridge.data_watchdog_ms 配置（现场可调）。
let lastInboundAt = 0
function noteInbound(): void { lastInboundAt = performance.now() }

export function useRos(url?: string) {
  // 连接参数在"调用时"读取而非模块加载时：静态 import 的模块顶层代码会先于
  // main.ts 的 await loadDashboardConfig() 执行，这里调用时配置已就绪。
  // host='auto' → 跟随页面主机（页面与 rosbridge 同机部署时局域网换 IP 零改动）；
  // 显式传 url 参数可完全覆盖（测试/特殊拓扑用）。
  const rosUrl = url ?? resolveRosBridgeUrl(getDashboardConfig())
  const cfg = getDashboardConfig().rosBridge
  reconnectDelay = cfg.reconnectInitialMs
  const DATA_WATCHDOG_MS = cfg.dataWatchdogMs
  function connect() {
    if (ros) { try { ros.close() } catch (_) {} }
    ros = new R.Ros({ url: rosUrl })
    ros.on('connection', () => {
      connected.value = true
      reconnectDelay = cfg.reconnectInitialMs // 重置重连延迟
      noteInbound()         // 连接建立即刷新看门狗基线（订阅数据到达前不误报）
      // 2026-09-06 缺陷修复：重连后重放全部订阅——新 ros 实例上没有旧 Topic，
      // 不重放则所有数据话题静默（3D 模型冻结/HUD 不更新的根因）。
      for (const entry of subRegistry) attachSubscription(entry)
    })
    ros.on('error', () => { connected.value = false })
    ros.on('close', () => {
      connected.value = false
      // 自动重连（指数退避）
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = setTimeout(() => connect(), reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 1.5, cfg.reconnectMaxMs)
    })
  }
  connect()

  // 看门狗循环：仅已连接时检查；超时强制断开（close → 既有重连链路接管自愈）。
  // noteInbound 先行防抖：重连建立前不重复触发，避免 close 风暴。
  const watchdogTimer = setInterval(() => {
    if (!connected.value) return
    if (performance.now() - lastInboundAt > DATA_WATCHDOG_MS) {
      console.warn('[useRos] 数据流看门狗：已连接但超 12s 无入站数据，强制重连自愈')
      noteInbound()
      try { ros?.close() } catch (_) {}
    }
  }, 5000)

  // 出站金丝雀（2026-08-30）：周期轻量调用 rosapi 探测出站通道；入站正常而出站
  // 死亡时（TCP 半开态），数据看门狗不会触发（入站仍在流），拖动流命令静默
  // 丢失——金丝雀 2.5s 超时即强制重连，拖动流最多丢一个探测周期。
  // 独立 caller（ros_canary）不占用应用 message_id 序列。
  let canaryBusy = false
  const canaryTimer = setInterval(() => {
    if (!connected.value || !ros || canaryBusy) return
    canaryBusy = true
    let done = false
    try {
      const srv = new R.Service({ ros, name: '/rosapi/get_time', serviceType: 'rosapi/Time' })
      srv.callService({}, () => { done = true; noteInbound() }, () => { done = true })
      setTimeout(() => {
        if (!done && connected.value) {
          console.warn('[useRos] 出站金丝雀 2.5s 超时，强制重连自愈')
          try { ros?.close() } catch (_) {}
        }
        canaryBusy = false
      }, cfg.canaryTimeoutMs)
    } catch (_) { canaryBusy = false }
  }, cfg.canaryIntervalMs)

  function subscribe(topicName: string, msgType: string, cb: (msg: any) => void) {
    if (!ros) return
    // 2026-09-06 缺陷修复：登记进注册表，重连后按注册表重放（见 attachSubscription）。
    const entry: SubEntry = { name: topicName, type: msgType, cb }
    subRegistry.push(entry)
    attachSubscription(entry)
    // 2026-09-05 教训补充：连接早已建立后才发起的订阅（如晚挂载面板）同样走
    // attachSubscription，与重连重放共用同一实现，行为一致。
  }

  async function callService(srvName: string, srvType: string, args: any = {}) {
    if (!ros || !connected.value) return { success: false, message: '未连接' }
    return new Promise((resolve) => {
      // —— 出站看门狗（2026-08-30 E2E 发现）——
      // 页面 roslib 连接会出现"入站正常、出站死亡"的半开态：服务调用发不出去且
      // 无任何回执，拖动只透传首条命令后永久失联。同页面新建 WebSocket 实测全通，
      // 故超时即强制断开，交由既有重连逻辑换新鲜 socket 自愈。
      let settled = false
      const srv = new R.Service({ ros, name: srvName, serviceType: srvType })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        console.warn(`[useRos] 服务调用 ${cfg.serviceTimeoutMs}ms 无响应，疑似出站通道死亡，强制重连自愈:`, srvName)
        try { ros?.close() } catch (_) {}
        resolve({ success: false, message: '调用超时（已触发重连自愈）' })
      }, cfg.serviceTimeoutMs)
      // roslib 2.x 的浏览器构建未导出 ServiceRequest；普通参数对象等价且可序列化。
      srv.callService(args, (res: any) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        noteInbound()
        resolve(res)
      }, () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ success: false, message: '调用失败' })
      })
    })
  }

  function publish(topicName: string, msgType: string, payload: any) {
    if (!ros) return
    // 2026-08-30 关键修复：roslib 2.1.0 的 ESM 构建不导出 Message 构造器，
    // `new R.Message()` 抛 TypeError → 关节球拖动的 topic 流全灭，且异常发生在
    // onPointerUp 清理代码之前 → 拖动态残留（"松手后继续控制/Esc 无效"）。
    // Topic.publish 只做 JSON 序列化转发，普通对象完全等价。
    const topic = new R.Topic({ ros, name: topicName, messageType: msgType })
    topic.publish(payload)
  }

  onUnmounted(() => {
    if (reconnectTimer) clearTimeout(reconnectTimer)
    clearInterval(watchdogTimer)   // 看门狗随组件卸载停止（防泄漏）
    clearInterval(canaryTimer)     // 出站金丝雀同上
  })

  return { connected, subscribe, callService, publish }
}
