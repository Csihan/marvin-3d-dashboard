/**
 * @file    dashboardConfig.ts
 * @brief   Web 大屏运行配置：dashboard.yaml 加载、逐键校验回退、连接地址解析
 * @author Csihan
 * @date    2026-09-03
 *
 * 设计（为什么这样组织）：
 *   - 配置文件 = public/dashboard.yaml（vite build 原样复制到 dist/，改完 F5 生效，
 *     无需重新构建）——现场可调参数的唯一来源，前后端（file_server.py）共用一份；
 *   - 逐键校验合并：任何键缺失 / 类型写错 / 文件不存在都回退内置默认值
 *     （默认值与 2026-09-03 改造前的硬编码行为逐一对应），配错只 console.warn，
 *     绝不白屏——现场大屏的可用性优先于配置正确性；
 *   - 生命周期：main.ts 在挂载前 await loadDashboardConfig() 写入模块单例，
 *     之后 useRos / useTeach / App / 组件经 getDashboardConfig() 同步读取；
 *   - 地址解析：host='auto' 表示跟随页面主机名——页面与 ROS 同机部署时，
 *     局域网换 IP / 主机名都零改动；分机部署时在 YAML 填 ROS 主机固定 IP 即可；
 *   - 话题名/服务名（协议 V1.0.8 冻结项）刻意不开放配置：改错会导致前端与
 *     comms 静默断链且无任何报错，收益远小于风险。
 */

import { load as parseYaml } from 'js-yaml'

/** rosbridge 连接与链路自愈参数（YAML 中为 snake_case，此处为解析后的 camelCase） */
export interface RosBridgeConfig {
  /** 'auto'=跟随页面主机；否则为显式 IP/主机名（分机部署场景） */
  host: string
  /** rosbridge 监听端口（rosbridge_server 默认 9090） */
  port: number
  /** 'ws'=明文（当前部署形态）/ 'wss'=加密（需证书，暂未部署） */
  protocol: 'ws' | 'wss'
  /** 断线首次重连延迟 ms（之后 ×1.5 指数退避） */
  reconnectInitialMs: number
  /** 重连延迟上限 ms */
  reconnectMaxMs: number
  /** 已连接但持续无入站数据的看门狗阈值 ms（TCP 假活自愈，2026-08-30 实战教训） */
  dataWatchdogMs: number
  /** 出站金丝雀探测周期 ms（入站活/出站死的半开态自愈） */
  canaryIntervalMs: number
  /** 金丝雀单次探测超时 ms（超时强制重连） */
  canaryTimeoutMs: number
  /** 单次服务调用无响应超时 ms（超时触发重连自愈） */
  serviceTimeoutMs: number
}

/** 示教文件服务（tools/file_server.py）连接参数 */
export interface FileServerConfig {
  /** 'auto'=前端跟随页面主机 / 服务端绑 0.0.0.0；否则显式地址（服务端按字面绑定） */
  host: string
  /** 监听端口（默认 8765；改端口需同步 tools/file_server.py 的启动参数） */
  port: number
}

/** 安全门禁 */
export interface SafetyConfig {
  /** true=命令经双门禁正常下发；false=冻结模式（sendCommand/sendStream 全部短路） */
  simulationOnly: boolean
}

/** 大屏运行配置聚合（getDashboardConfig 返回值） */
export interface DashboardConfig {
  rosBridge: RosBridgeConfig
  fileServer: FileServerConfig
  safety: SafetyConfig
}

/**
 * 内置默认值：与 2026-09-03 改造前的硬编码行为逐一对应（2000/10000/12000/6000/2500/4000
 * 分别来自 useRos.ts 原 reconnectDelay 初值、重连上限、DATA_WATCHDOG_MS、金丝雀周期、
 * 金丝雀超时、服务调用超时；9090/8765 为两端口的既定约定）。
 */
export const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  rosBridge: {
    host: 'auto', port: 9090, protocol: 'ws',
    reconnectInitialMs: 2000, reconnectMaxMs: 10000,
    dataWatchdogMs: 12000, canaryIntervalMs: 6000,
    canaryTimeoutMs: 2500, serviceTimeoutMs: 4000,
  },
  fileServer: { host: 'auto', port: 8765 },
  safety: { simulationOnly: true },
}

/** 模块单例：loadDashboardConfig() 成败都会写入；getDashboardConfig 供全局同步读取 */
let currentConfig: DashboardConfig = deepClone(DEFAULT_DASHBOARD_CONFIG)

/** 深拷贝：JSON 往返即可（配置全是平铺标量/对象，无函数/循环引用） */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 收窄为普通对象（数组/null 均不算），供逐段解析用 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** 严格数字：必须是有限正数（0/负数/NaN 一律视为配置错误，回退默认） */
function asPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/** 端口：1~65535 整数（0 为保留端口，负数/小数/字符串都非法） */
function asPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : null
}

/** 非空字符串（trim 后非空才有效，防止手滑写成空白） */
function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** 布尔收窄（'true' 字符串等一律不接受——YAML 原生支持布尔，写错就该暴露出来） */
function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/**
 * 校验并合并原始 YAML 数据 → DashboardConfig（纯函数，便于单测）。
 * @param raw  YAML 解析结果（任意结构，可能是损坏数据）
 * @param warn 配置错误告警回调（默认 console.warn；单测注入静默函数）
 * @returns    合并后的配置；非法键逐个回退默认，不影响其余合法键
 */
export function mergeDashboardConfig(
    raw: unknown,
    warn: (message: string) => void = (m) => console.warn(m)): DashboardConfig {
  const cfg = deepClone(DEFAULT_DASHBOARD_CONFIG)
  const root = asRecord(raw)
  if (!root) {
    // 根节点不是对象（如整文件写成了数组）：只有"确有内容"才告警，undefined 静默。
    if (raw !== undefined && raw !== null) {
      warn('[dashboardConfig] 配置根节点不是对象，已整体回退默认值')
    }
    return cfg
  }

  // —— ros_bridge 段：连接地址/端口/协议 + 六个自愈参数，逐键校验 ——
  const rb = asRecord(root.ros_bridge)
  if (rb) {
    const host = asNonEmptyString(rb.host)
    if (host) cfg.rosBridge.host = host
    else if (rb.host !== undefined) {
      warn(`[dashboardConfig] ros_bridge.host 非法（${String(rb.host)}），回退 '${cfg.rosBridge.host}'`)
    }
    const port = asPort(rb.port)
    if (port !== null) cfg.rosBridge.port = port
    else if (rb.port !== undefined) {
      warn(`[dashboardConfig] ros_bridge.port 非法（${String(rb.port)}），回退 ${cfg.rosBridge.port}`)
    }
    if (rb.protocol === 'ws' || rb.protocol === 'wss') cfg.rosBridge.protocol = rb.protocol
    else if (rb.protocol !== undefined) {
      warn(`[dashboardConfig] ros_bridge.protocol 非法（${String(rb.protocol)}，仅 ws/wss），回退 '${cfg.rosBridge.protocol}'`)
    }
    // 自愈参数数组：[YAML 键, 目标字段] 逐项校验，写错只回退该键。
    const timings: Array<[string, keyof RosBridgeConfig]> = [
      ['reconnect_initial_ms', 'reconnectInitialMs'],
      ['reconnect_max_ms', 'reconnectMaxMs'],
      ['data_watchdog_ms', 'dataWatchdogMs'],
      ['canary_interval_ms', 'canaryIntervalMs'],
      ['canary_timeout_ms', 'canaryTimeoutMs'],
      ['service_timeout_ms', 'serviceTimeoutMs'],
    ]
    for (const [yamlKey, field] of timings) {
      const num = asPositiveNumber(rb[yamlKey])
      if (num !== null) (cfg.rosBridge[field] as number) = num
      else if (rb[yamlKey] !== undefined) {
        warn(`[dashboardConfig] ros_bridge.${yamlKey} 非法（${String(rb[yamlKey])}，须为正数），回退 ${String(cfg.rosBridge[field])}`)
      }
    }
  } else if (root.ros_bridge !== undefined) {
    warn('[dashboardConfig] ros_bridge 段不是对象，整段回退默认值')
  }

  // —— file_server 段：示教文件服务地址/端口 ——
  const fs = asRecord(root.file_server)
  if (fs) {
    const host = asNonEmptyString(fs.host)
    if (host) cfg.fileServer.host = host
    else if (fs.host !== undefined) {
      warn(`[dashboardConfig] file_server.host 非法（${String(fs.host)}），回退 '${cfg.fileServer.host}'`)
    }
    const port = asPort(fs.port)
    if (port !== null) cfg.fileServer.port = port
    else if (fs.port !== undefined) {
      warn(`[dashboardConfig] file_server.port 非法（${String(fs.port)}），回退 ${cfg.fileServer.port}`)
    }
  } else if (root.file_server !== undefined) {
    warn('[dashboardConfig] file_server 段不是对象，整段回退默认值')
  }

  // —— safety 段：命令门禁总开关（false=冻结全部命令，属高危变更需评审） ——
  const safety = asRecord(root.safety)
  if (safety) {
    const flag = asBool(safety.simulation_only)
    if (flag !== null) cfg.safety.simulationOnly = flag
    else if (safety.simulation_only !== undefined) {
      warn(`[dashboardConfig] safety.simulation_only 非法（${String(safety.simulation_only)}，须为 true/false），回退 ${cfg.safety.simulationOnly}`)
    }
  } else if (root.safety !== undefined) {
    warn('[dashboardConfig] safety 段不是对象，整段回退默认值')
  }

  return cfg
}

/**
 * 拉取并解析 dashboard.yaml，结果写入模块单例。
 * @param fetchImpl 可注入的 fetch 实现（默认全局 fetch；单测不需要——merge 已覆盖）
 * @returns 解析后的配置；文件缺失/YAML 语法错误/网络失败时返回内置默认值
 * @note 必须在应用挂载前 await（main.ts bootstrap）；失败不抛出，保证大屏始终可启动。
 */
export async function loadDashboardConfig(
    fetchImpl: typeof fetch = fetch): Promise<DashboardConfig> {
  // BASE_URL 兼容非根路径部署（vite base 配置）；cache:no-store 保证 F5 必拿新配置。
  const url = `${import.meta.env.BASE_URL}dashboard.yaml`
  try {
    const res = await fetchImpl(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    currentConfig = mergeDashboardConfig(parseYaml(text) as unknown)
    console.info(`[dashboardConfig] 已加载 ${url}`, currentConfig)
  } catch (err) {
    // 回退默认值并告警：现场最常见的失败是"只改了 public 没同步 dist"或 YAML 缩进写错。
    currentConfig = deepClone(DEFAULT_DASHBOARD_CONFIG)
    console.warn(`[dashboardConfig] 加载 ${url} 失败（${String(err)}），已回退内置默认值`)
  }
  return currentConfig
}

/**
 * 读取当前运行配置。
 * @returns main.ts 挂载前 loadDashboardConfig() 之后 = 真实配置；之前 = 内置默认值
 */
export function getDashboardConfig(): DashboardConfig {
  return currentConfig
}

/** 页面 Location 的最小接口（单测传 { hostname } 假对象即可） */
export interface HostLike { hostname: string }

/**
 * 解析 host 字段：'auto' → 页面主机名（无页面环境如 node/SSR → 'localhost'）。
 * @param host 配置中的 host（'auto' 或显式 IP/主机名）
 * @param loc  页面 Location（默认全局 location；测试可注入假对象）
 */
export function resolveHost(host: string, loc?: HostLike): string {
  if (host !== 'auto') return host
  const hostname = (loc ?? (typeof location !== 'undefined' ? location : undefined))?.hostname
  return hostname ? hostname : 'localhost'
}

/**
 * 解析 rosbridge WebSocket 完整地址（如 ws://192.168.1.50:9090）。
 * @param cfg 运行配置（缺省读模块单例）
 * @param loc 页面 Location（缺省全局；测试注入假对象）
 */
export function resolveRosBridgeUrl(
    cfg: DashboardConfig = getDashboardConfig(),
    loc?: HostLike): string {
  const host = resolveHost(cfg.rosBridge.host, loc)
  return `${cfg.rosBridge.protocol}://${host}:${cfg.rosBridge.port}`
}

/**
 * 解析示教文件服务 HTTP 基地址（如 http://192.168.1.50:8765）。
 * @note 固定 http（非 https）：局域网文件服务暂不做 TLS，且页面本身为 http 部署，
 *       若将来页面上 https，这里需要同步升级（mixed-content 限制）。
 */
export function resolveFileServerBase(
    cfg: DashboardConfig = getDashboardConfig(),
    loc?: HostLike): string {
  const host = resolveHost(cfg.fileServer.host, loc)
  return `http://${host}:${cfg.fileServer.port}`
}