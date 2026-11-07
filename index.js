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

// 固定扩充 libuv 线程池至 16，避免高并发出站 DNS 解析阻塞文件 I/O
process.env.UV_THREADPOOL_SIZE = '16';

const { main } = require('./src/main');
main();
