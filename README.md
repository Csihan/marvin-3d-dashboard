# MARVIN 3D Dashboard（marvin-3d-dashboard）

> 全屏 3D 整机视图 + 四边纯文本 HUD 的机器人状态大屏（开源模板仓库）。
> 技术栈：Vue 3 + Vite + TypeScript + Three.js + urdf-loader + roslibjs + GSAP + CSS2DRenderer。
>
> [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
> ![Vue3](https://img.shields.io/badge/Vue-3.x-42b883) ![Three.js](https://img.shields.io/badge/Three.js-r185-black) ![urdf-loader](https://img.shields.io/badge/urdf--loader-0.13-8A2BE2)

## 开源示例说明（先读这段）

**本仓库是一个可二次开发的模板**：内置了一个纯 primitive 几何的开源示例机器人
（`public/models/urdf/demo_robot.urdf`，双臂 7-DOF + 4WS 底盘 + 升降躯干 + 双轴头部，
不含任何第三方 mesh 资产，版权干净）。克隆后 `npm install && npm run dev` 即可看到
可交互的 3D 大屏——模型拖拽、关节控制球、示教面板、键盘 Jog 全部离线可用。

**接入你的真实机器人**只需三步：

1. 把你的整机 URDF（xacro 需先展开成静态 URDF）放到 `public/models/urdf/`；
2. 若 URDF 使用 `package://` mesh 路径：mesh 拷到 `public/models/urdf/meshes/<包名>/`，
   并在 `src/composables/useRobot3D.ts` 的 `PACKAGE_MAP` 登记包名 → 静态路径映射；
3. 把 `useRobot3D.ts` 中 `loader.load('/models/urdf/demo_robot.urdf', …)` 的路径
   改成你的文件名。关节命名若与示例不同，同步调整 `ARM_JOINTS`/`labels.ts` 等
   常量（都有注释标注）。

> 命名约定：示例模型沿用 `Joint1~7_L/R`（双臂）、`gripper_L/R_joint`（夹爪，
> prismatic 单指 0~0.03m）、`head_yaw/pitch_joint`（头部）、`torso_lift_joint`
> （躯干升降 prismatic 0~0.55m）与 4 轮 4 转向关节——如果你的机器人同名，
> 前端零改动即可驱动。

## 快速上手

```bash
# 源码开发模式
git clone https://github.com/Csihan/marvin-3d-dashboard.git
cd marvin-3d-dashboard && npm install && npm run dev    # http://localhost:5173

# 或 npm 全局安装（CLI 一键启动，服务 dist/ 构建产物）
npm install -g marvin-3d-dashboard
marvin                                                   # http://localhost:8080
```

连接真实/仿真机器人：装好 rosbridge_suite 并启动 `rosbridge_websocket.launch`
（`:9090`），详见 [QUICKSTART.md](QUICKSTART.md)。

## 布局（四边纯文本 HUD，去卡片化）

```
┌──────────── HEADSTRIP（头部 左右/上下）────────────┐
│ ARM_L 左臂                          GRIP_L 左爪    │
│ ARM_R 右臂                          GRIP_R 右爪    │
│          ChassisStrip（行走1~4/转向1~4/升降/弯腰）    │
└────────────────────────────────────────────────────┘
```

- 左列双臂（L 上 / R 下）：模式 M0~M4 / FSM / J1~J7 角度 / 错误 / 软急停；
- 右列双爪（L 上 / R 下）：开度 % 大字 / 速度 / 力度 / 夹持状态；
- 顶条头部、底条底盘 10 电机明细（行走1~4/转向1~4/升降/弯腰；编码器/速度/电流/状态码/错误码）；
- 样式：数据区无背景无边框，可选 `--hud-tint: rgba(4,10,22,.25)` 超低透明衬底；
  标题 10px 大写宽字距、正文 11px 等宽。

## 数据链路

```
ROS 节点(arm/motor/comms) ──/robot/status(std_msgs/String JSON)──▶ rosbridge :9090
                                                                        │ roslibjs
                                        useRobotStatus.parseStatusMessage() ◀┘
                                          │ 按 module 分发（纯函数，可单测）
                                        robotStore(reactive) ─▶ 四边面板组件

/arm/joint_states(JointState) ─▶ useRobot3D.updateJoints() ─▶ robot.setJointValues()
                                                                        （URDF 关节名直驱）
```

## 底盘控制

点击 3D 底盘任意部位 → 弹出底盘控制面板 `ChassisPanel.vue`：

| 区域 | 内容 |
|---|---|
| 行走 1~4（只读） | 位置=pulse · 速度=RPM · 电流 A · 状态 |
| 转向 1~4（只读） | 位置=° · 速度=RPM · 电流 A · 状态 |
| 升降 Z（可控制） | 滑杆+数字+执行：目标 mm（绝对高度口径，映射到 URDF prismatic 滑台） |
| 弯腰 B（可控制） | 滑杆+数字+执行：目标 °（URDF ±90° 限位） |

3D 控制球（左键直拖、Alt 精细×0.1、120ms 节流、松手补发终值）：

- 升降球 🟢 绿：挂 `torso_lift_link`，竖直拖动=升降（mm↔URDF 滑台 0~0.55m 映射）；
- 弯腰球 🟣 紫：挂 `torso_link`，竖直拖动=弯腰（°→URDF rad）。

命令链路（均经 `sendCommand` 的 `simulation_only` 门禁）：

- 升降 → `human_extern_cmd{header.type:platform_control, content:{z:m}}` → comms 平台 z
  → 升降电机 → 反馈 watch 回驱 3D 预览；
- 弯腰 → `human_extern_cmd{header.type:motor_control, content:[{motor_type:2,target_angle:deg}]}`
  → comms → 弯腰电机 → 反馈 watch 回驱 3D 预览。

单位口径冻结（`src/utils/chassisUnits.ts`，前端显示层唯一换算点）：

| 电机 | 位置 | 速度 |
|---|---|---|
| 行走 1~4 | pulse（编码器脉冲） | RPM |
| 转向 1~4 | ° | RPM |
| 升降 | mm（绝对高度） | RPM |
| 弯腰 | °（±90） | RPM |

球拖动/滑杆方向若与你的真机运动相反：翻转 `useRobot3D.ts` 中 `CHASSIS_AXIS_SIGN`（±1）即可；
关节级方向差异同理用 `INVERT_JOINTS` 校准表逐关节吸收。

## 模型链路（URDFLoader + 整机 URDF）

- **选型**：整机 URDF（而非碎片化 GLB）——模型结构与关节语义同源，关节名直驱；
- **根因知识**：浏览器 URDFLoader 不解析 `package://` 与 xacro → 必须预展开 + 提供 packages 映射；
- 管线参考：`tools/export_web_urdf.sh`（xacro 展开 + mesh 收集的通用模板，按你的
  工作空间改三个路径变量）+ `tools/ascii_stl_to_binary.py`（ASCII→binary STL 体积减半）；
- 内置示例 `public/models/urdf/demo_robot.urdf` 全部用 URDF primitive 几何
  （box/cylinder），urdf-loader 原生解析，无需 mesh 文件；
- `useRobot3D.ts` 中 `PACKAGE_MAP` 把 `package://pkg/…` 映射到
  `/models/urdf/meshes/pkg/…`（内置示例为空映射，接入真实模型时按需登记）。

## 运行配置（dashboard.yaml）

现场可调参数集中在 `public/dashboard.yaml`（构建时原样复制到 `dist/dashboard.yaml`，
**改完浏览器 F5 即生效，无需重新构建**；键缺失/类型错误逐键回退内置默认值，不会白屏）：

| 段 | 键 | 说明 |
|---|---|---|
| ros_bridge | host / port / protocol | `auto`=跟随页面主机（同机部署推荐）；分机部署填 ROS 主机 IP |
| ros_bridge | reconnect_initial_ms / reconnect_max_ms / data_watchdog_ms / canary_interval_ms / canary_timeout_ms / service_timeout_ms | 链路自愈参数（断线退避重连、假活看门狗、出站金丝雀、服务超时） |
| file_server | host / port | 示教文件服务；`auto`=前端跟随页面主机、服务端绑 0.0.0.0（局域网监听，仅受信网络使用） |
| safety | simulation_only | 命令门禁总开关；`false`=冻结全部命令下发 |

- 话题名/服务名（协议冻结项）刻意不开放配置，防误改造成前端与后端静默断链；
- `tools/file_server.py`（:8765）读同一份 YAML 决定监听地址/端口
  （`--config` > dist > public，CLI `--host/--port` 最高）；
- 现场快速调整：改部署机 `dist/dashboard.yaml` → F5；长期基线：同步改回 `public/dashboard.yaml`；
- 局域网部署拓扑：任一台机器跑 ROS 栈 + rosbridge(:9090) + file_server(:8765) + 静态页(:8000)，
  任意机器浏览器访问 `http://<ROS主机IP>:8000` 即可；跨网段/端口受限环境自行用
  防火墙放行 8000/9090/8765 三个端口。

## 构建 / 部署 / 验证

### 日常开发循环

```bash
npm run dev            # 开发热更（Vite，http://localhost:5173）
npm run build          # vue-tsc -b && vite build → 产物落在 dist/
npm run test           # vitest 单元测试
npm run preview        # 本地预览构建产物
```

> 只改 `dashboard.yaml` 时无需重新构建：改部署机 `dist/dashboard.yaml` → 浏览器 F5 即可。

### 生产部署（任意 Linux/Windows 主机）

1. 主机安装 Node.js ≥ 18 → `npm run build` 得到 `dist/`（或在任一台机器构建后整目录拷贝 dist）；
2. 静态服务三选一：`npm i -g marvin-3d-dashboard && marvin`（自动开浏览器）、
   `python3 -m http.server 8000 --directory <dist路径>`、或任意静态服务器；
3. ROS 侧：`roscore` + `rosbridge_websocket.launch`（:9090）+（可选）`tools/file_server.py`（:8765）；
4. 防火墙放行 8000/9090/8765；局域网任意机器浏览器开 `http://<主机IP>:8000`；
5. 分机部署（页面与 ROS 不同机）：改 `dashboard.yaml` 的 `ros_bridge.host` 填 ROS 主机 IP。

### 验证清单

`npm run test`（单测全绿）+ `npm run build`（类型零错误）+ 页面 200 +
`dist/dashboard.yaml` 随构建更新（模型 404 自查：`/models/urdf/demo_robot.urdf`、
`/models/earth/*` 应全 200）。

## License

[MIT](LICENSE) © 2026 Csihan。内置示例模型（demo_robot.urdf）与全部源码按 MIT 交付；
接入你自己的机器人模型或第三方资产时，请自行确认相应资产的分发授权。