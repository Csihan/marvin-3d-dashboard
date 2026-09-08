# Tools 文档

> 模型资产管线工具：URDF 展开、STL 格式转换、减面、文件服务。

## 工具清单

### 1. `export_web_urdf.sh` — 整机 URDF + mesh 导出

**用途**：将你 ROS 工作空间里的 xacro 模型展开为浏览器可加载的静态 URDF + STL mesh。
**内置示例无需本工具**（demo_robot.urdf 为纯 primitive 几何）；接入真实机器人模型时使用。

**执行环境**：任意 ROS1 环境（需 xacro；脚本内三个路径变量按你的工作空间改）

**用法**：
```bash
# 在你的 ROS 环境内执行（脚本头注释有逐变量说明）
bash tools/export_web_urdf.sh
```

**产物**：
```
public/models/urdf/
├── robot.urdf            # 展开后的静态整机 URDF
└── meshes/
    └── <包名>/**         # 各源码包的 mesh（与 package:// 一一对应）
```

**原理**：
1. `xacro` 展开 `.urdf.xacro` → 静态 `.urdf`（浏览器无法解析 xacro 语法）；
2. 按 `package://pkg/...` 结构拷贝 mesh 目录（与前端 `PACKAGE_MAP` 一一对应）。

---

### 2. `ascii_stl_to_binary.py` — ASCII STL → 二进制转换

**用途**：ASCII STL 体积大（~250B/三角形），二进制 STL 固定 50B/三角形，体积约减半。

**执行环境**：Windows 侧，Python 3.8+，无第三方依赖

**用法**：
```bash
python tools/ascii_stl_to_binary.py public/models/urdf
```

**原理**：
- 逐行解析 `facet normal` / `vertex` 行，提取浮点数；
- 每个 facet 打包为 `12f + 1uint16`（50 字节）；
- 已是二进制的文件（首 5 字节非 `solid` 或文件大小不符规律）自动跳过。

---

### 3. `decimate_obj.py` — 大 OBJ 抽样减面

**用途**：流式读取大 OBJ（如 728MB），抽样减面 + mm→m 单位换算。

**用法**：
```bash
python tools/decimate_obj.py <input.obj> [output.obj] [ratio]
# ratio 默认 0.03（保留 3% 面）
```

**限制**：抽样减面不保证拓扑一致性，适合预览/评估；精确减面请用 `blender_decimate.py`。

---

### 4. `blender_decimate.py` — Blender 精确减面

**用途**：Blender 无头模式，OBJ 导入 → Quadric Edge Collapse Decimate → GLB 导出。

**用法**：
```bash
blender --background --python blender_decimate.py -- <input.obj> <output.glb> <ratio>
# ratio: 0.05 = 保留 5% 的面（1478万 → 74万面）
```

**原理**：
1. 清空场景 → 导入 OBJ → 合并所有 mesh → Decimate 修改器 → 应用 → mm→m → 导出 GLB。

---

### 5. `file_server.py` — 示教数据文件服务

**用途**：白名单读写 arm 示教 YAML / CSV 与夹爪预设 YAML。

**执行环境**：Windows 侧，Python 3.8+

**用法**：
```bash
python tools/file_server.py [--teach-dir <dir>] [--host <addr>] [--port 8765] [--config <yaml>]
# 2026-09-03：监听地址/端口默认读运行配置 dashboard.yaml（dist 优先、public 兜底）；
# CLI --host/--port 优先级最高；host:auto -> 0.0.0.0（局域网监听）。
```

**安全边界**：
- 监听地址默认 `127.0.0.1`；dashboard.yaml 的 `file_server.host: auto`（=0.0.0.0）
   可放开为局域网监听——放开=授权网内机器写示教文件，请务必仅在受信任的网络环境使用；
- 只接受 `arm_L` / `arm_R` / `gripper-presets` 三个固定资源名；
- 请求体上限 1 MiB。

**API**：
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/teach/{arm_L\|arm_R}` | 读取示教 YAML |
| PUT | `/api/teach/{arm_L\|arm_R}` | 保存示教 YAML |
| POST | `/api/export-csv/{arm_L\|arm_R}` | 导出 CSV（UTF-8 BOM） |
| GET | `/api/gripper-presets` | 读取夹爪预设 |
| PUT | `/api/gripper-presets` | 保存夹爪预设 |
