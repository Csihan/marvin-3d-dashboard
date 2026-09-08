#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
file_server.py：Web 大屏示教数据文件服务。

@file    file_server.py
@brief   白名单读写 arm 示教 YAML / CSV 与夹爪预设 YAML
@author Csihan
@date    2026-08-28

安全边界：
  1. 监听地址默认 127.0.0.1；dashboard.yaml 的 file_server.host:auto（=0.0.0.0）
     可放开为局域网监听——放开后仍受固定资源白名单与 1MiB 上限约束，
     但等于授权网内机器写示教文件，请务必仅在受信任的网络环境使用；
  2. 只接受 arm_L / arm_R / gripper-presets 三个固定资源名；
  3. CSV 只能写到同名固定文件，请求中不能携带路径；
  4. 请求体上限 1 MiB，防止误操作拖入超大文件。

2026-09-03：监听地址/端口改读 web-dashboard 运行配置 dashboard.yaml（与前端
共用同一份配置源）；解析顺序 --config > dist/dashboard.yaml > public/dashboard.yaml，
CLI --host/--port 优先级最高；host:auto → 0.0.0.0。
"""

import argparse
import json
import os
import re
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional

import yaml

# ─── 全局常量 ───
# 项目根目录（web-dashboard 的上两级目录）
BASE_DIR = Path(__file__).resolve().parents[2]
# teach 数据目录统一归属本仓库 config/teach（白名单资源名对应的实际存储位置）
DEFAULT_TEACH_DIR = BASE_DIR / "web-dashboard" / "config" / "teach"
# 示教文件映射表：资源名 → 文件名（白名单机制，只允许访问这两个文件）
TEACH_FILES = {
    "arm_L": "arm_L_teach.yaml",
    "arm_R": "arm_R_teach.yaml",
}
# 夹爪预设文件名
PRESET_FILE = "gripper_presets.yaml"
# 请求体大小上限：1 MiB（1048576 字节），防止误操作拖入超大文件
MAX_BODY_BYTES = 1024 * 1024


def fixed_resource(path: str, prefix: str) -> str:
    """Python 3.8 兼容的固定前缀解析；不做任何相对路径规范化。

    从请求路径中提取资源名（去掉 API 前缀），不做路径规范化以防止目录遍历攻击。
    例如："/api/teach/arm_L" + prefix="/api/teach/" → "arm_L"

    @param path    完整请求路径。
    @param prefix  API 前缀路径。
    @return        提取的资源名（空字符串表示不匹配）。
    """
    return path[len(prefix):] if path.startswith(prefix) else ""


class TeachFileServer(BaseHTTPRequestHandler):
    """固定路由的只读本机文件服务；所有写请求都落到构造时固定的 teach 目录。

    路由表（白名单）：
      GET  /api/teach/arm_L      → 读取 arm_L_teach.yaml
      GET  /api/teach/arm_R      → 读取 arm_R_teach.yaml
      GET  /api/gripper-presets  → 读取 gripper_presets.yaml
      PUT  /api/teach/arm_L      → 写入 arm_L_teach.yaml（原子写入）
      PUT  /api/teach/arm_R      → 写入 arm_R_teach.yaml（原子写入）
      PUT  /api/gripper-presets  → 写入 gripper_presets.yaml（原子写入）
      POST /api/export-csv/arm_L → 导出 CSV 文件（UTF-8 BOM，Excel 兼容）
      OPTIONS                      → CORS 预检响应
    """

    # 类属性：示教数据目录（由 main() 在启动时设置）
    teach_dir: Path = DEFAULT_TEACH_DIR

    def _send(self, status: int, payload: Any = None, raw: Optional[bytes] = None,
              content_type: str = "application/json; charset=utf-8") -> None:
        """统一响应发送方法：设置 CORS 头、Content-Type、Cache-Control 等。

        CORS 策略：只允许来自 localhost:8000 或 localhost:5173 的跨端口请求
        （开发环境 Vite 用 5173，生产环境 http.server 用 8000）。

        @param status       HTTP 状态码。
        @param payload      JSON 响应体（会自动序列化）。
        @param raw          原始字节响应体（优先于 payload）。
        @param content_type Content-Type 头（默认 JSON）。
        """
        # 从请求头中获取 Origin，用于 CORS 校验
        origin = self.headers.get("Origin", "")
        # 只放行来自 localhost:8000 或 localhost:5173 的跨端口请求
        cors_origin = origin if re.fullmatch(
            r"https?://[^/:]+:(8000|5173)", origin) else ""
        # 序列化 JSON 响应体（ensure_ascii=False 支持中文，紧凑分隔符减小体积）
        body = raw if raw is not None else json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # 发送 HTTP 响应头
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")  # 禁止缓存（每次请求都读最新文件）
        self.send_header("Access-Control-Allow-Origin", cors_origin)
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> Dict[str, Any]:
        """读取并解析请求体中的 JSON 数据（带大小和格式校验）。

        校验规则：
          1. Content-Length 必须在 1 ~ 1 MiB 之间；
          2. 请求体必须是合法 JSON；
          3. 解析结果必须是 dict 类型。

        @return  解析后的 JSON 字典。
        @raises ValueError  请求体超限或格式不合法。
        @raises json.JSONDecodeError  JSON 语法错误。
        """
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("请求体必须为 1 字节到 1 MiB")
        value = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return value

    def _atomic_write(self, name: str, data: bytes) -> None:
        """原子写入文件：先写临时文件，再 rename 覆盖原文件。

        保证写入过程中不会出现半写状态（断电/崩溃时临时文件被丢弃，原文件完整）。

        @param name  目标文件名（相对于 teach_dir）。
        @param data  要写入的字节数据。
        """
        target = self.teach_dir / name
        # 确保目录存在（首次写入时自动创建）
        self.teach_dir.mkdir(parents=True, exist_ok=True)
        # 在同一目录下创建临时文件（rename 必须在同一文件系统）
        fd, temp_name = tempfile.mkstemp(prefix=".upload-", dir=self.teach_dir)
        try:
            with os.fdopen(fd, "wb") as fp:
                fp.write(data)
            # 原子替换：rename 在同一文件系统下是原子操作
            os.replace(temp_name, target)
        except Exception:
            # 写入失败时清理临时文件（避免残留 .upload-* 文件）
            try:
                os.unlink(temp_name)
            except FileNotFoundError:
                pass
            raise

    # ══════════════════════════════════════════════════════════════
    # HTTP 方法处理
    # ══════════════════════════════════════════════════════════════

    def do_OPTIONS(self) -> None:  # noqa: N802
        """浏览器跨端口调用前会发 preflight（OPTIONS 预检请求），这里只返回固定 CORS 头。"""
        self._send(204, raw=b"")

    def do_GET(self) -> None:  # noqa: N802
        """处理 GET 请求：读取示教 YAML / 夹爪预设并返回 JSON。

        路由：
          - /api/gripper-presets → 读取 gripper_presets.yaml
          - /api/teach/{arm_L|arm_R} → 读取对应的示教 YAML
          - 其他路径 → 404
        """
        # ─── 夹爪预设读取 ───
        if self.path == "/api/gripper-presets":
            target = self.teach_dir / PRESET_FILE
            # 文件不存在时返回空预设结构（前端不会报错）
            data = yaml.safe_load(target.read_text(encoding="utf-8")) if target.exists() else {"presets": {}}
            self._send(200, data)
            return
        # ─── 示教文件读取（白名单校验）───
        resource = fixed_resource(self.path, "/api/teach/")
        # 路径严格匹配校验：防止路径注入（如 "/api/teach/../../etc/passwd"）
        if self.path != f"/api/teach/{resource}" or resource not in TEACH_FILES:
            self._send(404, {"error": "not found"})
            return
        target = self.teach_dir / TEACH_FILES[resource]
        # 文件不存在时返回空运动表结构
        data = yaml.safe_load(target.read_text(encoding="utf-8")) if target.exists() else {"named_points": []}
        self._send(200, data)

    def do_PUT(self) -> None:  # noqa: N802
        """处理 PUT 请求：写入示教 YAML / 夹爪预设（原子写入，防半写）。

        路由：
          - PUT /api/gripper-presets → 写入 gripper_presets.yaml
          - PUT /api/teach/{arm_L|arm_R} → 写入对应的示教 YAML
          - 其他路径 → 404

        安全校验：
          1. 请求体必须是 JSON 对象；
          2. 示教文件必须包含 named_points 数组；
          3. 夹爪预设必须包含 presets 对象；
          4. 自动补充 replay_auto_enable 默认值。
        """
        try:
            payload = self._read_json()
            # ─── 夹爪预设写入 ───
            if self.path == "/api/gripper-presets":
                if not isinstance(payload.get("presets"), dict):
                    raise ValueError("presets 必须是对象")
                # 原子写入 YAML（allow_unicode=True 保留中文，sort_keys=False 保持字段顺序）
                self._atomic_write(PRESET_FILE, yaml.safe_dump(
                    payload, allow_unicode=True, sort_keys=False).encode("utf-8"))
                self._send(200, {"ok": True})
                return
            # ─── 示教文件写入（白名单校验）───
            resource = fixed_resource(self.path, "/api/teach/")
            if self.path != f"/api/teach/{resource}" or resource not in TEACH_FILES:
                self._send(404, {"error": "not found"})
                return
            # 自动补充 replay_auto_enable 默认值（协议兼容）
            payload.setdefault("replay_auto_enable", False)
            if not isinstance(payload.get("named_points"), list):
                raise ValueError("named_points 必须是数组")
            # 原子写入示教 YAML
            self._atomic_write(TEACH_FILES[resource], yaml.safe_dump(
                payload, allow_unicode=True, sort_keys=False).encode("utf-8"))
            self._send(200, {"ok": True})
        except (ValueError, json.JSONDecodeError, yaml.YAMLError) as exc:
            # 参数校验失败 / JSON 语法错误 / YAML 语法错误 → 返回 400
            self._send(400, {"error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        """处理 POST 请求：导出 CSV 文件（UTF-8 BOM，Excel 兼容中文）。

        路由：
          - POST /api/export-csv/{arm_L|arm_R} → 导出对应臂的示教 CSV
          - 其他路径 → 404

        CSV 格式：
          - 首行 = 列头（seq, name, x, y, z, qw, qx, qy, qz, j1deg~j7deg）；
          - 每行 = 一个示教点位；
          - 编码 = UTF-8 + BOM（\xef\xbb\xbf），让 Excel 自动识别中文。
        """
        try:
            payload = self._read_json()
            # ─── CSV 导出（白名单校验）───
            resource = fixed_resource(self.path, "/api/export-csv/")
            if self.path != f"/api/export-csv/{resource}" or resource not in TEACH_FILES:
                self._send(404, {"error": "not found"})
                return
            content = payload.get("content")
            # 校验：CSV 内容必须是以换行结尾的文本字符串
            if not isinstance(content, str) or not content.endswith("\n"):
                raise ValueError("CSV content 必须是以换行结尾的文本")
            # 校验：CSV 大小不能超过 1 MiB
            if len(content.encode("utf-8")) > MAX_BODY_BYTES:
                raise ValueError("CSV 超过 1 MiB 上限")
            # 生成 CSV 文件名（将 .yaml 替换为 .csv）
            csv_name = TEACH_FILES[resource].replace(".yaml", ".csv")
            # 写入 CSV（UTF-8 BOM 让 Excel 按 UTF-8 识别中文点位名）
            self._atomic_write(csv_name, b"\xef\xbb\xbf" + content.encode("utf-8"))
            self._send(200, {"ok": True, "file": csv_name})
        except (ValueError, json.JSONDecodeError) as exc:
            self._send(400, {"error": str(exc)})

    def log_message(self, format: str, *args: Any) -> None:
        """重写日志方法：默认 stderr 访问日志会混入 ROS 输出；本地开发只保留错误由 HTTPServer 打印。"""
        return


def main() -> None:
    """主入口：解析配置并启动 HTTP 文件服务。

    配置解析优先级（从高到低）：
      1. CLI 参数 --host / --port（最高优先级，覆盖所有配置）；
      2. CLI 参数 --config 指定的 YAML 文件；
      3. dist/dashboard.yaml（构建产物，现场改完即生效）；
      4. public/dashboard.yaml（源仓库基线，构建时复制进 dist）；
      5. 内置默认值（host=127.0.0.1, port=8765）。

    启动流程：
      1. 解析命令行参数；
      2. 加载 dashboard.yaml 配置（host:auto → 0.0.0.0）；
      3. 创建 ThreadingHTTPServer（多线程，支持并发请求）；
      4. 绑定地址并启动服务。
    """
    # ─── 命令行参数定义 ───
    parser = argparse.ArgumentParser(description="MARVIN Web 示教文件服务")
    parser.add_argument("--teach-dir", type=Path, default=DEFAULT_TEACH_DIR,
                        help="固定示教数据目录")
    parser.add_argument("--port", type=int, default=None,
                        help="监听端口（缺省读 dashboard.yaml，再缺省 8765）")
    parser.add_argument("--host", default=None,
                        help="监听地址（缺省读 dashboard.yaml，再缺省 127.0.0.1）")
    parser.add_argument("--config", type=Path, default=None,
                        help="运行配置 YAML（缺省 dist 优先、public 兜底）")
    args = parser.parse_args()

    # ─── 2026-09-03：与前端共用同一份运行配置 dashboard.yaml（单一配置源）───
    # 解析顺序：--config 显式指定 > dist/dashboard.yaml（现场改完即生效，构建产物）
    #          > public/dashboard.yaml（源仓库基线，构建时复制进 dist）。
    config_path = args.config
    if config_path is None:
        dist_cfg = BASE_DIR / "web-dashboard" / "dist" / "dashboard.yaml"
        pub_cfg = BASE_DIR / "web-dashboard" / "public" / "dashboard.yaml"
        config_path = dist_cfg if dist_cfg.exists() else pub_cfg
    # 内置默认值（与历史行为一致）
    cfg_host, cfg_port = "127.0.0.1", 8765
    try:
        with open(config_path, "r", encoding="utf-8") as fp:
            section = (yaml.safe_load(fp) or {}).get("file_server") or {}
        # host 须为非空字符串；'auto' 在下方映射为 0.0.0.0（监听全部网卡）
        raw_host = section.get("host")
        if isinstance(raw_host, str) and raw_host.strip():
            cfg_host = raw_host.strip()
        # port 须为 1~65535 整数，越界/错型一律用默认（配置服务端与前端同一口径）
        raw_port = section.get("port")
        if isinstance(raw_port, int) and 1 <= raw_port <= 65535:
            cfg_port = raw_port
    except (OSError, yaml.YAMLError) as exc:
        # 配置文件缺失/YAML 语法错误：降级为内置默认并明示，保证文件服务总能起来
        print(f"[file_server] 配置 {config_path} 读取失败（{exc}），使用内置默认")

    # ─── 最终参数合并（CLI 参数 > 配置文件 > 内置默认）───
    # CLI 显式参数优先级最高（保持既有运维习惯）；host:auto → 0.0.0.0
    host = args.host if args.host is not None else cfg_host
    if host == "auto":
        host = "0.0.0.0"  # 监听全部网卡（局域网可访问）
    port = args.port if args.port is not None else cfg_port

    # ─── 启动服务 ───
    # 设置示教数据目录（类属性，所有请求共享）
    TeachFileServer.teach_dir = args.teach_dir.resolve()
    # 创建多线程 HTTP 服务器（ThreadingHTTPServer 支持并发处理多个请求）
    server = ThreadingHTTPServer((host, port), TeachFileServer)
    print(f"teach file server: http://{host}:{port} dir={TeachFileServer.teach_dir} cfg={config_path}")
    # 阻塞式启动服务（Ctrl+C 退出）
    server.serve_forever()


# ─── 脚本入口：直接运行时调用 main() ───
if __name__ == "__main__":
    main()
