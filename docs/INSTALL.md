# MARVIN 3D Dashboard — 新用户安装指南

> 面向初次使用者:不需要懂前端工程,只需要会装 Node.js 和打开终端。

---

## 一、第一次使用(源码方式,只做一次)

### 1. 装 Node.js(没有的话)

- 打开 https://nodejs.org/zh-cn/download/
- 下载 **20.x LTS** 版本,一路下一步安装
- 装完打开终端,跑 `node -v`,看到 `v20.x.x` 即可

### 2. 获取并启动

```bash
git clone https://github.com/Csihan/marvin-3d-dashboard.git
cd marvin-3d-dashboard
npm install          # 公共 npm 源即可,约 1~3 分钟
npm run dev          # 开发模式 http://localhost:5173
```

或构建后用 CLI 启动:

```bash
npm run build
npm run marvin       # http://localhost:8080,自动开浏览器
```

### 3. 全局安装方式(可发布/部署机形态)

```bash
npm install -g marvin-3d-dashboard
marvin
```

---

## 二、改 ROS Bridge IP(连接你的机器人)

### 方法 1:外部配置文件(推荐)

1. 新建 `dashboard.yaml`,内容:
   ```yaml
   ros_bridge:
     host: 192.168.1.50    # 改成你 ROS 主机的实际 IP(示例值,按需替换)
     port: 9090
   ```
2. CLI 启动时指定:
   ```bash
   marvin --config=/path/to/dashboard.yaml
   ```

### 方法 2:改仓库默认值

直接改 `public/dashboard.yaml` 的 `ros_bridge.host`(同机部署用 `auto` 即可),
重新 `npm run build`。

---

## 三、升级

```bash
npm update -g marvin-3d-dashboard
```

---

## 四、卸载

```bash
npm uninstall -g marvin-3d-dashboard
```

---

## 五、常见问题

| 问题 | 解决 |
|---|---|
| `marvin` 不是内部或外部命令 | 重开终端窗口;或 `npm config get prefix` 看路径,加到 PATH |
| 浏览器没自动开 | 手动访问终端里显示的地址 |
| 端口 8080 被占 | `marvin --port=9000` |
| 3D 模型加载空白 | 确认 `public/models/urdf/` 下有 URDF 文件,清浏览器缓存重试 |
| 机器人不动 | rosbridge 未连接(看右上角徽标)或 ROS IP 配错,见"改 ROS Bridge IP" |
| 让局域网其他设备也能访问 | `marvin --host=0.0.0.0`,其他设备浏览器开 `http://<你的IP>:8080` |

---

## 六、命令速查

```bash
marvin                  # 默认启动
marvin --port=9000      # 改端口
marvin --host=0.0.0.0   # 局域网可访问
marvin --no-open        # 不自动开浏览器
marvin --help           # 帮助
```

---

## 七、更多帮助

- 项目主页:https://github.com/Csihan/marvin-3d-dashboard
- 问题反馈:https://github.com/Csihan/marvin-3d-dashboard/issues