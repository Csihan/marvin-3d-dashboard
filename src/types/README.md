# Types 文档

> TypeScript 类型定义 + 协议字段中文映射。
> 所有类型与 `robot_comms_node` 各 `onXxxStatus` 组装的 JSON 一一对应。

## 清单

### `robot.ts` — 核心类型

**接口（Interface）**：

| 接口 | 说明 | 数据源 |
|---|---|---|
| `ArmStatus` | 单臂状态 | `/robot/status` module=arm_L/arm_R |
| `GripperStatus` | 单爪状态 | `/robot/status` module=gripper_L/gripper_R |
| `HeadStatus` | 头部状态 | `/robot/status` module=head_yaw/head_pitch |
| `MotorElectric` | 底盘单电机明细 | `/robot/status` module=wheel_1..4/steer_1..4/lift_motor/bend_motor |
| `ChassisStatus` | 底盘整体 | 聚合 4行走+4转向+升降+弯腰 |
| `DemoActionStatus` | S 动作执行回报 | `/robot/status` type=demo_action_report |
| `TeachPoint` | 示教运动表一行 | useTeach 采样/文件读写 |
| `GripperPreset` | 夹爪预设 | YAML 文件 |
| `ArmModeKind` | 段/臂级模式 | P-B 动作库 |
| `ModeEvent` | 模式切换事件 | P-B 动作库 |
| `ActionLibraryConfig` | 动作库配置 | P-B 动作库 |
| `ArmAction` | 单臂动作段 | P-B 动作库 |
| `ActionLibrary` | 整机动作库 | P-B 动作库 JSON |
| `RobotStatusStore` | 聚合状态 store | useRobotStatus 响应式 store |

**常量**：
| 常量 | 说明 |
|---|---|
| `TOOL0_RPY` | tool0 参考系 RPY = [1.5708, 0, 0]（URDF 实况） |
| `ARM_MODE_NAMES` | 模式编号 → 中文（-1=未知, 0=下使能, 1=位置, 2=PVT, 3=扭矩, 4=拖动） |
| `GRIP_STATUS_NAMES` | 夹持状态 → 中文（0=运动中, 1=到位, 2=夹持, 3=掉落） |

**函数**：
| 函数 | 说明 |
|---|---|
| `fsmLabel(fsm)` | 状态机状态名 → 展示文本（UNINIT=未初始化, IDLE=空闲, ...） |
