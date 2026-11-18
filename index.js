#!/usr/bin/env node
'use strict';
/**
 * NEON PIXEL — Retro Arcade Web Game & Realtime Sync Engine (Node.js >= 18, 零外部依赖)
 *
 * 环境变量：
 *   PORT          全局监听端口（默认 8080）
 *   UUID          接口与会话令牌 UUID（不设则首次启动自动生成并持久化到 uuid 文件）
 *   TOKEN         边缘状态同步扩展令牌（可选）
 */

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) { console.error(`需要 Node.js >= 18，当前 ${process.version}`); process.exit(1); }

// 极速 CLI 短路路径：--help 与容器高频 --healthcheck 零业务模块加载、零额外线程开销
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`NEON PIXEL Retro Arcade Server
用法: [环境变量...] node index.js [--check] [--healthcheck] [--help]
环境变量：
  PORT            全局监听端口（默认 8080）
  UUID            接口与会话令牌 UUID（不设则首次启动自动生成并持久化到 uuid 文件）
  TOKEN           边缘同步扩展令牌（可选）
CLI 选项：
  --check         只检查配置是否有效，不启动服务
  --healthcheck   探测本地正在运行的服务 (/healthz)，用于容器 HEALTHCHECK`);
  process.exit(0);
}

if (process.argv.includes('--healthcheck')) {
  const http = require('http');
  const fs = require('fs');
  const path = require('path');
  const pi = process.argv.indexOf('--port');
  let rawPort = (pi > 0 ? process.argv[pi + 1] : undefined) || process.env.PORT || '';
  if (!rawPort && process.env.PORT_FILE) {
    try { rawPort = fs.readFileSync(process.env.PORT_FILE, 'utf8').trim(); } catch {}
  }
  if (!rawPort) {
    try {
      const envText = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
      const m = /^\s*(?:export\s+)?PORT\s*=\s*["']?(\d+)["']?/m.exec(envText);
      if (m) rawPort = m[1];
    } catch {}
  }
  const port = parseInt(rawPort || '8080', 10) || 8080;
  const req = http.get({ host: '127.0.0.1', port, path: '/healthz', timeout: 4000 }, (res) => {
    res.resume();
    process.exit(res.statusCode === 200 ? 0 : 1);
  });
  req.on('timeout', () => { req.destroy(); process.exit(1); });
  req.on('error', () => process.exit(1));
} else {
  // 按真实容器可用内存自适应配置 libuv 线程池（PaaS 小内存收敛至 6，高配 VPS 扩充至 16）
  if (!process.env.UV_THREADPOOL_SIZE) {
    const os = require('os');
    const constrained = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
    const total = os.totalmem();
    const availMB = Math.floor(((constrained > 0 && constrained < total) ? constrained : total) / 1048576);
    process.env.UV_THREADPOOL_SIZE = availMB <= 512 ? '6' : '16';
  }
  const { main } = require('./src/main');
  main();
}
