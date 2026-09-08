/**
 * @file    dashboardConfig.test.ts
 * @brief   运行配置合并/逐键回退/地址解析单元测试（纯函数，不依赖真实 dashboard.yaml）
 * @author Csihan
 * @date    2026-09-03
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DASHBOARD_CONFIG,
  mergeDashboardConfig,
  resolveFileServerBase,
  resolveHost,
  resolveRosBridgeUrl,
} from '../dashboardConfig'

/** 静默告警回调：只断言合并结果，不校验告警输出 */
const silent = (): void => {}

describe('mergeDashboardConfig 逐键校验回退', () => {
  it('空对象 / undefined → 全默认值', () => {
    expect(mergeDashboardConfig({}, silent)).toEqual(DEFAULT_DASHBOARD_CONFIG)
    expect(mergeDashboardConfig(undefined, silent)).toEqual(DEFAULT_DASHBOARD_CONFIG)
  })

  it('根节点损坏（数组/标量）→ 整体回退', () => {
    expect(mergeDashboardConfig([1, 2], silent)).toEqual(DEFAULT_DASHBOARD_CONFIG)
    expect(mergeDashboardConfig('oops', silent)).toEqual(DEFAULT_DASHBOARD_CONFIG)
  })

  it('合法覆盖逐键生效，未覆盖键保持默认', () => {
    const cfg = mergeDashboardConfig({
      ros_bridge: {
        host: '192.168.1.50', port: 9191, protocol: 'wss',
        data_watchdog_ms: 8000, service_timeout_ms: 6000,
      },
      file_server: { host: '10.0.0.9', port: 9000 },
      safety: { simulation_only: false },
    }, silent)
    expect(cfg.rosBridge.host).toBe('192.168.1.50')
    expect(cfg.rosBridge.port).toBe(9191)
    expect(cfg.rosBridge.protocol).toBe('wss')
    expect(cfg.rosBridge.dataWatchdogMs).toBe(8000)
    expect(cfg.rosBridge.serviceTimeoutMs).toBe(6000)
    expect(cfg.rosBridge.reconnectInitialMs).toBe(2000)   // 未覆盖 → 默认
    expect(cfg.rosBridge.reconnectMaxMs).toBe(10000)
    expect(cfg.rosBridge.canaryIntervalMs).toBe(6000)
    expect(cfg.rosBridge.canaryTimeoutMs).toBe(2500)
    expect(cfg.fileServer).toEqual({ host: '10.0.0.9', port: 9000 })
    expect(cfg.safety.simulationOnly).toBe(false)
  })

  it('非法值逐键回退，不影响同段其余合法键', () => {
    const cfg = mergeDashboardConfig({
      ros_bridge: {
        host: '', port: 'abc', protocol: 'ftp',
        reconnect_max_ms: -5, data_watchdog_ms: 0, canary_timeout_ms: null,
        canary_interval_ms: 9000,   // 同段里夹一个合法键，验证隔离性
      },
      file_server: { port: 99999 },
      safety: { simulation_only: 'yes' },
    }, silent)
    expect(cfg.rosBridge.host).toBe('auto')
    expect(cfg.rosBridge.port).toBe(9090)
    expect(cfg.rosBridge.protocol).toBe('ws')
    expect(cfg.rosBridge.reconnectMaxMs).toBe(10000)
    expect(cfg.rosBridge.dataWatchdogMs).toBe(12000)
    expect(cfg.rosBridge.canaryTimeoutMs).toBe(2500)
    expect(cfg.rosBridge.canaryIntervalMs).toBe(9000)     // 合法键正常生效
    expect(cfg.fileServer.port).toBe(8765)
    expect(cfg.safety.simulationOnly).toBe(true)
  })

  it('段结构错误整段回退（段内逐键校验不适用）', () => {
    const cfg = mergeDashboardConfig({ ros_bridge: 'oops', file_server: [1], safety: 0 }, silent)
    expect(cfg.rosBridge).toEqual(DEFAULT_DASHBOARD_CONFIG.rosBridge)
    expect(cfg.fileServer).toEqual(DEFAULT_DASHBOARD_CONFIG.fileServer)
    expect(cfg.safety).toEqual(DEFAULT_DASHBOARD_CONFIG.safety)
  })
})

describe('地址解析', () => {
  it("host='auto' 跟随页面主机名", () => {
    expect(resolveHost('auto', { hostname: '10.0.0.5' })).toBe('10.0.0.5')
  })

  it('显式 host 原样返回（分机部署场景）', () => {
    expect(resolveHost('192.168.1.50', { hostname: 'ignored' })).toBe('192.168.1.50')
  })

  it('无页面环境（node/SSR）回退 localhost', () => {
    expect(resolveHost('auto', undefined)).toBe('localhost')
  })

  it('rosbridge / file_server 完整地址拼接', () => {
    const loc = { hostname: '172.30.55.191' }
    expect(resolveRosBridgeUrl(DEFAULT_DASHBOARD_CONFIG, loc)).toBe('ws://172.30.55.191:9090')
    expect(resolveFileServerBase(DEFAULT_DASHBOARD_CONFIG, loc)).toBe('http://172.30.55.191:8765')
  })

  it('协议/端口覆盖后地址同步变化', () => {
    const cfg = mergeDashboardConfig(
      { ros_bridge: { protocol: 'wss', port: 9191 }, file_server: { port: 9000 } }, silent)
    expect(resolveRosBridgeUrl(cfg, { hostname: 'marvin' })).toBe('wss://marvin:9191')
    expect(resolveFileServerBase(cfg, { hostname: 'marvin' })).toBe('http://marvin:9000')
  })
})
