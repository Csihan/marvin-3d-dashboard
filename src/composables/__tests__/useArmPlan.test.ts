/**
 * @file    useArmPlan.test.ts
 * @brief   useArmPlan 协议封装单测（协议 V1.0.9，2026-09-03）
 * @author Csihan
 * @date    2026-09-03
 *
 * 验证「Web 命令 → comms 协议 JSON」载荷组装的正确性（send 捕获断言）。
 * 用注入的 mock send/subscribe 验证：
 *   - 关节规划/笛卡尔规划/中断的载荷字段与单位口径
 *   - 双臂协同（关节/笛卡尔）载荷
 *   - IK/FK 求解的 pose/quaternion 结构
 *   - 场力控制/末端通信/系统控制字段
 *   - 异步响应捕获（ik/fk/end_tool 经 /robot/status 回传）
 */
import { describe, expect, it } from 'vitest'
import { useArmPlan, armToId } from '../useArmPlan'

/** 构造注入：捕获 send 载荷的 mock；可注入 fake subscribe 模拟异步响应 */
function setup() {
  const sent: Array<{ type: string; content: any }> = []
  let handler: ((msg: any) => void) | null = null
  const send = async (type: string, content: any) => {
    sent.push({ type, content })
    return { content: { ret: true }, values: 'ok' }
  }
  const subscribe = (topic: string, _t: string, cb: (msg: any) => void) => {
    if (topic === '/robot/status') handler = cb
    return { unsubscribe: () => { handler = null } }
  }
  // 工具：从 responder 发一条异步响应给 handler
  const emitResponse = (type: string, data: any) => {
    handler?.({ data: JSON.stringify({
      header: { type },
      content: { ret: true, data },
    }) })
  }
  return { ctl: useArmPlan(send, subscribe), sent, emitResponse }
}

describe('armToId 臂映射', () => {
  it('arm_L → 1，arm_R → 2', () => {
    expect(armToId('arm_L')).toBe(1)
    expect(armToId('arm_R')).toBe(2)
  })
})

describe('在线规划（pln_control）', () => {
  it('关节规划：action=1 + start/stop_joints(rad) + vel/acc 比', async () => {
    const { ctl, sent } = setup()
    await ctl.plnJoint({
      action: 1, arm: 1,
      startJoints: [0, 0, 0, 0, 0, 0, 0],
      stopJoints: [0.5, -0.3, 0, 0, 0, 0, 0],
      velRatio: 30, accRatio: 30,
    })
    expect(sent[0]).toEqual({
      type: 'pln_control',
      content: {
        arm: 1, action: 1,
        start_joints: [0, 0, 0, 0, 0, 0, 0],
        stop_joints: [0.5, -0.3, 0, 0, 0, 0, 0],
        vel_ratio: 30, acc_ratio: 30,
      },
    })
  })

  it('笛卡尔规划：action=2 + start/end_xyzabc(mm+deg) + 速度约束', async () => {
    const { ctl, sent } = setup()
    await ctl.plnCart({
      action: 2, arm: 2,
      startXyzabc: [0, 0, 500, 0, 0, 0],
      endXyzabc: [100, 0, 400, 0, 0, 0],
      refJoints: [0, 0, 0, 0, 0, 0, 0],
      velMmS: 100, accMmS2: 100, freq: 50,
    })
    expect(sent[0].type).toBe('pln_control')
    expect(sent[0].content.action).toBe(2)
    expect(sent[0].content.arm).toBe(2)
    expect(sent[0].content.start_xyzabc).toEqual([0, 0, 500, 0, 0, 0])
    expect(sent[0].content.end_xyzabc).toEqual([100, 0, 400, 0, 0, 0])
    expect(sent[0].content.vel_mm_s).toBe(100)
    expect(sent[0].content.acc_mm_s2).toBe(100)
    expect(sent[0].content.freq).toBe(50)
  })

  it('中断：action=3', async () => {
    const { ctl, sent } = setup()
    await ctl.plnStop(1)
    expect(sent[0]).toEqual({ type: 'pln_control', content: { arm: 1, action: 3 } })
  })
})

describe('双臂协同（co_pln_control）', () => {
  it('关节协同：action=1 + 双臂起止', async () => {
    const { ctl, sent } = setup()
    await ctl.coPlnJoint({
      action: 1,
      startA: [0, 0, 0, 0, 0, 0, 0], stopA: [0.5, 0, 0, 0, 0, 0, 0],
      startB: [0, 0, 0, 0, 0, 0, 0], stopB: [-0.5, 0, 0, 0, 0, 0, 0],
      velRatio: 20, accRatio: 20,
    })
    expect(sent[0].type).toBe('co_pln_control')
    expect(sent[0].content.action).toBe(1)
    expect(sent[0].content.start_a).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(sent[0].content.stop_a).toEqual([0.5, 0, 0, 0, 0, 0, 0])
    expect(sent[0].content.stop_b).toEqual([-0.5, 0, 0, 0, 0, 0, 0])
  })

  it('笛卡尔协同：action=3 + 双臂起止 XYZABC + 参考角(deg)', async () => {
    const { ctl, sent } = setup()
    await ctl.coPlnCart({
      action: 3,
      startXyzabcA: [0, 0, 500, 0, 0, 0], endXyzabcA: [100, 0, 500, 0, 0, 0],
      startXyzabcB: [0, 0, 500, 0, 0, 0], endXyzabcB: [-100, 0, 500, 0, 0, 0],
      refJointsA: [0, 0, 0, 0, 0, 0, 0], refJointsB: [0, 0, 0, 0, 0, 0, 0],
      velMmS: 80, accMmS2: 80, freq: 50,
    })
    expect(sent[0].type).toBe('co_pln_control')
    expect(sent[0].content.action).toBe(3)
    expect(sent[0].content.start_xyzabc_a).toEqual([0, 0, 500, 0, 0, 0])
    expect(sent[0].content.end_xyzabc_b).toEqual([-100, 0, 500, 0, 0, 0])
    expect(sent[0].content.ref_joints_a).toEqual([0, 0, 0, 0, 0, 0, 0])
    expect(sent[0].content.vel_mm_s).toBe(80)
  })

  it('中断协同：action=2', async () => {
    const { ctl, sent } = setup()
    await ctl.coPlnStop()
    expect(sent[0]).toEqual({ type: 'co_pln_control', content: { action: 2 } })
  })
})

describe('运动学（ik_solve / fk_solve）', () => {
  it('IK：pose 组装为 position{m}+quaternion{wxyz}，异步回传 joint_angles', async () => {
    const { ctl, sent, emitResponse } = setup()
    const p = ctl.ikSolve(1, { x: 0.5, y: 0, z: 0.8, qw: 1, qx: 0, qy: 0, qz: 0 })
    // 服务受理后，驱动侧异步经 /robot/status 回传关节角
    emitResponse('ik_solve', { joint_angles: [0.1, -0.2, 0.3, 0, 0, 0, 0] })
    const ja = await p
    expect(sent[0].type).toBe('ik_solve')
    expect(sent[0].content).toEqual({
      arm: 1,
      pose: {
        position: { x: 0.5, y: 0, z: 0.8 },
        quaternion: { w: 1, x: 0, y: 0, z: 0 },
      },
    })
    expect(ja).toEqual([0.1, -0.2, 0.3, 0, 0, 0, 0])
  })

  it('FK：joint_angles 直传，异步回传 pose[m+quat]', async () => {
    const { ctl, sent, emitResponse } = setup()
    const p = ctl.fkSolve(2, [0.1, 0, 0, 0, 0, 0, 0])
    emitResponse('fk_solve', { pose: [0.5, 0, 0.8, 1, 0, 0, 0] })
    const ps = await p
    expect(sent[0].type).toBe('fk_solve')
    expect(sent[0].content).toEqual({ arm: 2, joint_angles: [0.1, 0, 0, 0, 0, 0, 0] })
    expect(ps).toEqual([0.5, 0, 0.8, 1, 0, 0, 0])
  })
})

describe('场力控制（ft_control）', () => {
  it('字段映射与 ArmFtControl.srv 一致', async () => {
    const { ctl, sent } = setup()
    await ctl.ftControl({
      arm: 1,
      fxDir: [0, 0, 1, 0, 0, 0],
      k: 10, f: 5, freeDis: 2, dis: 50,
      kn: 8, tn: 1, nFreeDis: 3, ndis: 10,
    })
    expect(sent[0].type).toBe('ft_control')
    expect(sent[0].content).toEqual({
      arm: 1,
      fx_dir: [0, 0, 1, 0, 0, 0],
      k: 10, f: 5, free_dis: 2, dis: 50,
      kn: 8, tn: 1, n_free_dis: 3, ndis: 10,
    })
  })
})

describe('末端通信（end_tool）', () => {
  it('发送：data 字节数组 + data_size', async () => {
    const { ctl, sent } = setup()
    await ctl.endToolSend({ arm: 1, action: 1, ch: 2, data: [0x01, 0x03, 0x00] })
    expect(sent[0].type).toBe('end_tool')
    expect(sent[0].content).toEqual({
      arm: 1, action: 1, ch: 2,
      data: [1, 3, 0], data_size: 3,
    })
  })

  it('接收：异步回传字节数组 + 通道 + 长度', async () => {
    const { ctl, sent, emitResponse } = setup()
    const p = ctl.endToolRecv(1, 1)
    emitResponse('end_tool', { data: [0xAA, 0x55], ch: 1, size: 2 })
    const res = await p
    expect(sent[0].content).toEqual({ arm: 1, action: 2, ch: 1 })
    expect(res).toEqual({ data: [170, 85], ch: 1, size: 2 })
  })
})

describe('系统控制（sys_control）', () => {
  it('设置时间：action=1 + 6 项', async () => {
    const { ctl, sent } = setup()
    await ctl.sysSetTime({ year: 2026, month: 9, day: 3, hour: 10, minute: 30, second: 0 })
    expect(sent[0].type).toBe('sys_control')
    expect(sent[0].content).toEqual({ action: 1, year: 2026, month: 9, day: 3, hour: 10, minute: 30, second: 0 })
  })

  it('软重启：action=2', async () => {
    const { ctl, sent } = setup()
    await ctl.sysReboot()
    expect(sent[0]).toEqual({ type: 'sys_control', content: { action: 2 } })
  })
})