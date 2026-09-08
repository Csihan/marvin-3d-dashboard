# Utils 文档

> 纯函数工具库，无状态、无副作用、可独立单测。

## 清单

### `chassisUnits.ts` — 底盘电机显示单位换算

**设计背景**：底盘电机上报值为仿真域数值（deg/s、mm/s），显示层需要换算为用户冻结的单位口径。

**常量**：
| 常量 | 值 | 说明 |
|---|---|---|
| `LIFT_MIN_MM` | 903.3 | 升降行程下限（绝对高度 mm），来自 ProtocolParser.cpp |
| `LIFT_MAX_MM` | 1453.3 | 升降行程上限（绝对高度 mm） |
| `BEND_MIN_DEG` | -90 | 弯腰关节下限（°），URDF torso_pitch_joint ±1.5708rad |
| `BEND_MAX_DEG` | 90 | 弯腰关节上限（°） |

**函数**：
| 函数 | 输入 | 输出 | 说明 |
|---|---|---|---|
| `toRpm(velSim)` | 仿真域速度 | RPM | ÷6 折算（deg/s → 每分钟量） |
| `toWheelPulse(encoderDeg)` | 编码器 deg | pulse | 原样取整（Mock 以 deg 代替脉冲） |
| `liftMmToUrdf(mm)` | 绝对高度 mm | URDF 行程 m | 903.3→0, 1453.3→0.55 线性映射 |
| `urdfToLiftMm(m)` | URDF 行程 m | 绝对高度 mm | 上述逆映射 |

---

### `trajectory.ts` — 笛卡尔轨迹插值

**设计背景**：P-B 示教踩点回放时，点与点之间不再用关节空间线性插值，而是用 minimum-jerk 五阶多项式，产生仿人手臂的平滑运动质感。

**数学原理**：
- **minimum-jerk ease**：`f(t) = 6t⁵ - 15t⁴ + 10t³`
  - f(0)=0, f(1)=1，一阶/二阶导在两端均为 0
  - 正是人体手臂"从静止平滑起步、再平滑停下"的数学模型
- **四元数 slerp**：球面插值，避免欧拉角万向锁，保证过渡最短路径

**函数**：
| 函数 | 说明 |
|---|---|
| `easeInOut(x)` | minimum-jerk 五阶多项式 ease（x ∈ [0,1]） |
| `slerpQuat(q0, q1, t)` | 两点间四元数 slerp |
| `toCartesianPose(p)` | TeachPoint → CartesianPose（缺失字段按单位姿态兜底） |
| `planCartesian(from, to, options)` | 两点间 minimum-jerk 笛卡尔轨迹规划 |
| `trajectoryLength(samples)` | 整条轨迹长度（m，相邻采样点欧氏距离累加） |
| `resampleForVelocity(samples, speedMs, fps)` | 按目标速度稀疏化/加密采样点 |

**用法示例**：
```typescript
const samples = planCartesian(from, to, { samples: 60, dwell: true })
// samples[i].pos / samples[i].quat 即第 i 帧末端位姿
```
