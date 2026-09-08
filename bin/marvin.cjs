#!/usr/bin/env node
// ============================================================
// marvin —— MARVIN 3D 示教大屏 全局 CLI 入口
//
// @file    bin/marvin.cjs
// @brief   `npm i -g marvin-3d-dashboard` 后,`marvin` 启动本地静态服务 + 自动开浏览器
// @author Csihan
// @date    2026-09-07
//
// 用法(用户视角):
//   npm i -g marvin-3d-dashboard
//   marvin                    # 默认 http://localhost:8080
//   marvin --port=9000        # 改端口
//   marvin --host=0.0.0.0     # 允许局域网访问
//   marvin --no-open          # 不自动开浏览器(纯服务器模式)
//
// 设计要点:
//   - 用 CJS 而非 ESM,因为 package.json "type": "module",而 bin 脚本要被她机器的 node 直接执行;
//   - serve 走 `npx serve`(已在 dependencies 隐式可用,但这里我们手写极简版避免 npx 二次下载);
//   - 端口冲突自动 +1 探测;
//   - 配置文件在包内 dist/dashboard.yaml,用户可用 --config 覆盖到外部路径;
//   - 退出 SIGINT/SIGTERM 优雅关停子进程(关键:避免遗留 npx 僵尸)。
// ============================================================

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const os = require('os');

// —— 解析参数(朴素版本,避免引入 commander 等依赖)——
const args = process.argv.slice(2);
const opts = {
  port: 8080,
  host: '127.0.0.1',
  open: true,
  config: null,
};
for (const a of args) {
  if (a.startsWith('--port=')) opts.port = parseInt(a.slice(7), 10);
  else if (a === '--port') {/* 跳过,下条解析 */}
  else if (a.startsWith('--host=')) opts.host = a.slice(7);
  else if (a === '--no-open') opts.open = false;
  else if (a === '--help' || a === '-h') {
    printHelp();
    process.exit(0);
  } else if (a.startsWith('--config=')) opts.config = a.slice(9);
  else if (/^\d+$/.test(a)) opts.port = parseInt(a, 10);
}

function printHelp() {
  console.log(`marvin - MARVIN 3D 示教大屏

用法:
  marvin [options]

选项:
  --port=<n>        监听端口(默认 8080)
  --host=<ip>       监听地址(默认 127.0.0.1,局域网访问用 0.0.0.0)
  --no-open         不自动打开浏览器
  --config=<path>   外部 dashboard.yaml 覆盖(用于改 ROS IP)
  -h, --help        显示本帮助
`);
}

// —— 定位包内 dist/ ——
 // npm i -g 后,dist 在 <prefix>/lib/node_modules/marvin-3d-dashboard/dist/
// __dirname 是 bin 目录,所以 ../dist 即可
const PKG_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(PKG_ROOT, 'dist');

if (!fs.existsSync(DIST_DIR)) {
  console.error(`[marvin] ✗ 找不到 dist/ 目录: ${DIST_DIR}`);
  console.error(`[marvin] 提示:包可能损坏,尝试重装:npm i -g marvin-3d-dashboard --force`);
  process.exit(1);
}

// —— 外部 config 覆盖(用户改 ROS IP 用)——
if (opts.config) {
  const externalCfg = path.resolve(opts.config);
  if (fs.existsSync(externalCfg)) {
    const target = path.join(DIST_DIR, 'dashboard.yaml');
    fs.copyFileSync(externalCfg, target);
    console.log(`[marvin] 已加载外部配置: ${externalCfg}`);
  } else {
    console.error(`[marvin] ✗ 配置文件不存在: ${externalCfg}`);
  }
}

// —— 极简 MIME 映射(只覆盖 web 用得到的)——
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.urdf': 'application/xml',
  '.dae':  'model/vnd.collada+xml',
  '.stl':  'model/stl',
  '.obj':  'model/obj',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml':  'text/yaml; charset=utf-8',
};

// —— 端口冲突探测(从 opts.port 开始,最多 +20)——
function tryListen(host, port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.once('listening', () => {
      const actualPort = srv.address().port;
      srv.close(() => resolve(actualPort));
    });
    srv.listen(port, host);
  });
}

async function pickPort() {
  for (let p = opts.port; p < opts.port + 20; p++) {
    try {
      return await tryListen(opts.host, p);
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error(`无法找到可用端口(${opts.port}~${opts.port + 19})`);
}

// —— 静态文件服务 ——
function safeJoin(root, url) {
  // 防止 ../ 路径穿越
  const resolved = path.resolve(root, '.' + url.split('?')[0]);
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url);
  let filePath = safeJoin(DIST_DIR, urlPath);
  if (!filePath) { res.writeHead(403); return res.end('forbidden'); }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    // SPA fallback: 任何找不到的路径返回 index.html
    filePath = path.join(DIST_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Cache-Control': 'no-cache',
    // 允许 ROS 桥接 WebSocket 跨域(以防前端与 ROS 分机部署)
    'Access-Control-Allow-Origin': '*',
  });
  fs.createReadStream(filePath).pipe(res);
}

// —— 启动 ——
(async () => {
  const actualPort = await pickPort();
  const server = http.createServer(serveStatic);
  server.listen(actualPort, opts.host);

  const url = `http://${opts.host === '0.0.0.0' ? 'localhost' : opts.host}:${actualPort}/`;
  const banner = `
╔══════════════════════════════════════════════════════════╗
║  🟢 MARVIN 3D 示教大屏已启动                              ║
╠══════════════════════════════════════════════════════════╣
║  地址: ${url.padEnd(48)}║
║  局域网: http://<本机IP>:${String(actualPort).padEnd(36)}║
║  停止: Ctrl+C                                            ║
╚══════════════════════════════════════════════════════════╝`;
  console.log(banner);

  if (opts.open) {
    const cmd = process.platform === 'darwin' ? `open "${url}"`
              : process.platform === 'win32'  ? `start "" "${url}"`
              : `xdg-open "${url}"`;
    exec(cmd, (err) => {
      if (err) console.log(`[marvin] 自动开浏览器失败,请手动访问 ${url}`);
    });
  }

  // 优雅退出(关键:不让 Node 在 Windows 残留)
  let exiting = false;
  const shutdown = (sig) => {
    if (exiting) return;
    exiting = true;
    console.log(`\n[marvin] 收到 ${sig},关闭中...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})().catch(err => {
  console.error(`[marvin] ✗ 启动失败: ${err.message}`);
  process.exit(1);
});
