<!-- marvin-3d-dashboard 快速上手(本文件自包含,不依赖任何内部仓库路径) -->

## 🚀 快速启动(Web 3D 大屏 + ROS 联调)

内置示例模型开箱即用:克隆仓库后 `npm install && npm run dev`,浏览器打开
`http://localhost:5173/` 即可看到 3D 机器人(此时 ROS 未连接,右上角徽标为
「未连接」,3D 模型仍可拖动观察——所有交互面板均可用,命令下发被安全门禁拦截)。

### 方式一:源码开发模式(推荐 first run)

```bash
git clone https://github.com/Csihan/marvin-3d-dashboard.git
cd marvin-3d-dashboard
npm install          # Node.js >= 18,公共 npm 源即可
npm run dev          # 开发服务器 http://localhost:5173
```

### 方式二:npm 全局安装(CLI 一键启动)

```bash
npm install -g marvin-3d-dashboard
marvin               # 默认 http://localhost:8080,自动开浏览器
```

`marvin` 命令服务的是构建产物 `dist/`,改前端代码需重新 `npm run build`;
常用参数:`--port=9000` 改端口、`--host=0.0.0.0` 局域网可访问、
`--config=<dashboard.yaml>` 外部配置覆盖(改 ROS IP 用)、`--no-open` 不开浏览器。

### 连接 ROS 栈(可选,接入真实/仿真机器人时)

大屏通过 **rosbridge_suite** 的 WebSocket 桥(`:9090`)与 ROS 通信,
任意 ROS1 环境可复现:

```bash
# ① 安装 rosbridge(以 Ubuntu + ROS1 noetic 为例,版本按你的环境替换)
sudo apt install ros-noetic-rosbridge-suite

# ② 启动 ROS 核心与 rosbridge WebSocket 服务
roscore &
source /opt/ros/noetic/setup.bash
roslaunch rosbridge_server rosbridge_websocket.launch    # 默认监听 :9090

# ③ (可选)示教文件服务——运动表/夹爪预设读写
python3 tools/file_server.py --port 8765
```

浏览器打开大屏后,右上角 ROS 徽标变「**已连接**」即链路就绪:

- 页面与 rosbridge **同机**部署:`public/dashboard.yaml` 保持 `ros_bridge.host: auto`
  (自动跟随页面主机名,零改动);
- **分机**部署:把 `dashboard.yaml` 的 `ros_bridge.host` 改成 ROS 主机 IP;
- 上报 `/joint_states`(标准 JointState,关节名需与模型一致)与
  `/robot/status`(String JSON 状态)即可驱动 3D 与四边面板,详见 README「数据链路」。

> 没有机器人环境?照样玩:3D 模型拖拽/聚焦/示教面板/键盘 Jog 全部离线可用,
> 命令只会在「已连接 + 门禁开启」时真正下发。

### 键盘 Jog 速查(进入示教后生效)

| 键 | 功能 | 键 | 功能 |
|---|---|---|---|
| W/S | 末端进退 | Q/E | 偏航旋转 |
| A/D | 左右横移 | Z/X | 俯仰旋转 |
| R/F | 升降 | 1/2/3 | 步长 2mm→10mm→30mm |

按住=持续移动,**松开=立即停**;未进示教/焦点在输入框时自动屏蔽(安全互锁)。

> 📖 完整参数说明(rosbridge 自愈参数/示教文件服务/安全门禁)见
> [README.md](README.md)「运行配置」章节;接入自有机器人模型见
> README「开源示例说明」。