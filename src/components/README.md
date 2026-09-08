# Web Dashboard 组件文档

> 本目录包含 MARVIN 3D Web 示教大屏的所有 Vue 3 组件。
> 按功能分为五类：**控制面板** / **状态 HUD** / **底部坞** / **3D 场景辅助** / **通用基础**。

## 组件清单

### 控制面板（点击 3D 部位弹出）

| 组件 | 文件 | 触发方式 | 功能 |
|---|---|---|---|
| `ArmPanel` | `ArmPanel.vue` | 点击 3D 手臂 | 单臂 J1~J7 滑条点动、模式切换(M0~M4)、HOME、软急停 |
| `JointInspector` | `JointInspector.vue` | 双击 3D 关节球 | 单关节精调、链联动、pending 状态显示、清错结果 |
| `GripperPanel` | `GripperPanel.vue` | 点击 3D 夹爪 | 开度/力度/速度滑条、初始化/闭合/打开、YAML 预设 |
| `ChassisPanel` | `ChassisPanel.vue` | 点击 3D 底盘 | 行走/转向只读明细、升降 mm / 弯腰 ° 控制 |
| `HeadPanel` | `HeadPanel.vue` | 点击 3D 头部 | 摇头 yaw / 点头 pitch 滑条+执行 |

### 状态 HUD（四边常显，无需点击）

| 组件 | 文件 | 位置 | 功能 |
|---|---|---|---|
| `ArmStatusPanel` | `ArmStatusPanel.vue` | 左列×2 | 单臂 模式/FSM/J1~J7角度/错误/软急停 |
| `GripperStatusPanel` | `GripperStatusPanel.vue` | 右列×2 | 单爪 开度%/速度/力度/夹持状态/错误 |
| `HeadStrip` | `HeadStrip.vue` | 顶部 | 头部 左右摇头+上下点头（角度/电流/状态） |
| `ChassisStrip` | `ChassisStrip.vue` | 底部 | 底盘 9电机（行走4/转向4/升降/弯腰）明细 |

### 底部菜单坞

| 组件 | 文件 | 功能 |
|---|---|---|
| `BottomDock` | `BottomDock.vue` | 呼吸式胶囊坞：动作(S00~S14) + 示教 + 高级(阻抗/力控/PVT/参数) + 视图复位 + E-STOP |

### 3D 场景辅助

| 组件 | 文件 | 功能 |
|---|---|---|
| `HeaderBar` | `HeaderBar.vue` | 顶部标题 + 右上角模式徽标(MOCK/REAL/检测中)与帮助入口 + 右下角 ROS 状态/急停台（2026-09-04：全景按钮移除，视图复位统一走底部 dock） |
| `HelpGuide` | `HelpGuide.vue` | 全屏操作指南浮层：界面总览/朝向口径/键鼠组合/底部坞/退出安全 八章节（2026-09-04 扩充） |
| `PanelGuide` | `PanelGuide.vue` | 高级面板通用「参数说明」折叠块：统一 9 个高级页签的参数指南排版（2026-09-04 新增） |

### 通用基础

| 组件 | 文件 | 功能 |
|---|---|---|
| `StatusText` | `StatusText.vue` | 通用键值行（label 左 + value 右，等宽字体） |
| `ChartPanel` | `ChartPanel.vue` | 双臂 J2 实时曲线（ECharts 折线图） |
| `MotionTable` | `MotionTable.vue` | 示教运动表（seq/name/xyz四元数/j关节角） |
| `TeachModePanel` | `TeachModePanel.vue` | 示教操作入口（臂选择/进入退出/YAML读写/CSV导出） |
| `ControlPanel` | `ControlPanel.vue` | 中央示教控制坞（TeachModePanel + MotionTable 组合） |
| `StatusDock` | `StatusDock.vue` | 右下紧凑状态坞（摘要+可展开电机明细） |

## 数据流

```
App.vue (useRobotStatus.robotStore)
  │
  ├──→ ArmStatusPanel / GripperStatusPanel / HeadStrip / ChassisStrip
  │     （只读展示，无控制逻辑）
  │
  ├──→ ArmPanel / GripperPanel / JointInspector / ChassisPanel / HeadPanel
  │     （控制面板，通过 emit 向上传递命令）
  │     │
  │     └──→ App.vue 事件处理函数（sendCommand / sendStream）
  │           │
  │           └──→ rosbridge (/robot/human_extern_cmd 或 topic 流)
  │
  └──→ BottomDock / TeachModePanel / MotionTable
        （示教/动作，通过 emit 向上传递操作）
```

## 样式约定

- 所有组件使用 `<style scoped>` 隔离样式
- 全局 CSS 变量定义在 App.vue `:root` 中（`--acc` / `--tx` / `--dim` 等）
- 字号走 `--fs-row` / `--fs-title` / `--fs-cap` / `--fs-big` 自适应变量
- 面板统一用 `.side-panel` 基类（半透明渐变背景 + 毛玻璃 + 圆角）
- 状态色：ok=绿 / warn=琥珀 / err=红+发光 / dim=灰
