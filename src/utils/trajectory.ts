/**
 * @file    trajectory.ts
 * @brief   笛卡尔轨迹插值：minimum-jerk 位置样条 + 四元数 slerp（仿人手臂运动）
 * @author Csihan
 * @date    2026-08-30
 *
 * 设计口径（P-B 踩点/动作库专项，用户讨论确认）：
 *   - 方案 A 逐点示教：点与点之间不再用关节空间线性插值，而是用 minimum-jerk
 *     （最小加加速度）五阶多项式速度曲线，先加速后减速，符合人体点对点运动模型，
 *     使回放动作具有"仿人手臂"的平滑质感；
 *   - 姿态用四元数 slerp（球面插值），避免欧拉角万向锁、保证过渡最短路径；
 *   - 纯函数、无副作用、不碰 DOM，可独立单测；three.js 为项目既有依赖，
 *     仅复用其数学类（Vector3/Quaternion），无新增依赖。
 *
 * 用法示例：
 *   const samples = planCartesian(from, to, { samples: 60 })
 *   // samples[i].pos / samples[i].quat 即第 i 帧末端位姿
 */

import * as THREE from 'three'

/** 笛卡尔端点：tool0 位姿（位置 m + 四元数，模型域） */
export interface CartesianPose {
  x: number
  y: number
  z: number
  qw: number
  qx: number
  qy: number
  qz: number
}

/** 规划参数 */
export interface CartesianPlanOptions {
  /** 采样点数（默认 60 = 1s @60Hz；时间轴由外部按 dwell/速度档缩放） */
  samples?: number
  /** 起止端点是否带 dwell 停留（各占 samples 的 1/8，模拟"到位停顿"手感） */
  dwell?: boolean
}

/** 单帧采样：位置 + 姿态 + 归一化时间 0..1 */
export interface CartesianSample {
  pos: THREE.Vector3
  quat: THREE.Quaternion
  t: number
}

/**
 * minimum-jerk 五阶多项式 ease：6x⁵-15x⁴+10x³。
 * 特性：f(0)=0、f(1)=1，一阶/二阶导在两端均为 0 —— 起止速度与加速度为零，
 * 正是人体手臂"从静止平滑起步、再平滑停下"的数学模型。
 * @param x 归一化时间 [0,1]
 */
export function easeInOut(x: number): number {
  const t = THREE.MathUtils.clamp(x, 0, 1)
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * 两点间四元数 slerp（three 原生，短路径 + 自动处理 q 与 -q 符号）。
 * @param q0/q1 起止四元数（未归一化也安全，内部 normalize）
 */
export function slerpQuat(
  q0: { x: number; y: number; z: number; w: number },
  q1: { x: number; y: number; z: number; w: number },
  t: number,
): THREE.Quaternion {
  const a = new THREE.Quaternion(q0.x, q0.y, q0.z, q0.w).normalize()
  const b = new THREE.Quaternion(q1.x, q1.y, q1.z, q1.w).normalize()
  return a.slerp(b, THREE.MathUtils.clamp(t, 0, 1))
}

/** 便捷：TeachPoint 或任意含四元数字段的对象 → CartesianPose（缺失字段按单位姿态兜底）。 */
export function toCartesianPose(p: Partial<CartesianPose> & { x?: number; y?: number; z?: number }): CartesianPose {
  return {
    x: Number(p.x ?? 0),
    y: Number(p.y ?? 0),
    z: Number(p.z ?? 0),
    qw: Number(p.qw ?? 1),
    qx: Number(p.qx ?? 0),
    qy: Number(p.qy ?? 0),
    qz: Number(p.qz ?? 0),
  }
}

/**
 * 规划两点间 minimum-jerk 笛卡尔轨迹。
 * 位置三轴各自按 easeInOut 插值；姿态四元数 slerp。
 * @param from/to 起止 tool0 位姿
 * @param options samples 采样数 / dwell 首尾各插入停留帧
 * @returns 采样帧数组（含首尾；若两点重合返回单帧）
 */
export function planCartesian(
  from: CartesianPose,
  to: CartesianPose,
  options: CartesianPlanOptions = {},
): CartesianSample[] {
  const samples = Math.max(2, Math.floor(options.samples ?? 60))
  const p0 = new THREE.Vector3(from.x, from.y, from.z)
  const p1 = new THREE.Vector3(to.x, to.y, to.z)
  const q0 = new THREE.Quaternion(from.qx, from.qy, from.qz, from.qw).normalize()
  const q1 = new THREE.Quaternion(to.qx, to.qy, to.qz, to.qw).normalize()

  // 两点重合（位置 + 姿态均一致）→ 单帧，避免除零/无意义插值
  const samePos = p0.distanceToSquared(p1) < 1e-10
  const sameQuat = q0.angleTo(q1) < 1e-6
  if (samePos && sameQuat) {
    return [{ pos: p0.clone(), quat: q0.clone(), t: 0 }]
  }

  const out: CartesianSample[] = []
  const dwell = options.dwell ?? false
  // dwell 首尾各占 1/8：头尾插入"静止到位"帧，强化演示停顿手感
  const head = dwell ? Math.max(1, Math.floor(samples / 8)) : 0
  const tail = dwell ? Math.max(1, Math.floor(samples / 8)) : 0
  const move = Math.max(2, samples - head - tail)

  for (let i = 0; i < head; i++) out.push({ pos: p0.clone(), quat: q0.clone(), t: 0 })
  for (let i = 0; i < move; i++) {
    const t = move === 1 ? 1 : i / (move - 1)
    const s = easeInOut(t)
    out.push({
      pos: p0.clone().lerp(p1, s),
      quat: q0.clone().slerp(q1, s),
      t,
    })
  }
  for (let i = 0; i < tail; i++) out.push({ pos: p1.clone(), quat: q1.clone(), t: 1 })
  return out
}

/** 整条轨迹长度（m，相邻采样点欧氏距离累加，用于按速度档换算总时长）。 */
export function trajectoryLength(samples: CartesianSample[]): number {
  let len = 0
  for (let i = 1; i < samples.length; i++) len += samples[i].pos.distanceTo(samples[i - 1].pos)
  return len
}

/** 按目标速度（m/s）把采样点稀疏化/加密到接近目标帧间隔（60Hz 时间步）。 */
export function resampleForVelocity(
  samples: CartesianSample[],
  speedMs: number,
  fps = 60,
): CartesianSample[] {
  if (samples.length <= 2 || speedMs <= 0) return samples
  const step = speedMs / fps                       // 每帧期望位移
  const out: CartesianSample[] = [samples[0]]
  let acc = 0
  for (let i = 1; i < samples.length; i++) {
    acc += samples[i].pos.distanceTo(samples[i - 1].pos)
    if (acc >= step || i === samples.length - 1) {
      // 取与累计位移最接近的采样点（线性找，采样数不大）
      let pick = samples[i]
      let pickAcc = acc
      for (let j = i; j >= 1; j--) {
        const d = samples[i].pos.distanceTo(samples[j - 1].pos)
        if (Math.abs(d - step) < Math.abs(pickAcc - step)) { pickAcc = d; pick = samples[j - 1] }
      }
      out.push({ pos: pick.pos.clone(), quat: pick.quat.clone(), t: pick.t })
      acc = 0
    }
  }
  return out
}
