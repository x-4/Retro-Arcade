'use strict';
// 启动与自治守护中枢：配置检查、监听绑定、本地回环自检看门狗、内存水位保护与优雅停机

const http = require('http');
const os = require('os');
const { CFG, BASE, uuidSource, EDGE, checkConfig } = require('./config');
const { log } = require('./log');
const { stats, recordAlert } = require('./stats');
const { registry } = require('./channel');
const { sessions } = require('./session');
const { createServer } = require('./server');
const { startEdge, stopEdge } = require('./edge');
const { flushBoardSync } = require('./arcade');

const errTimes = [];
function onFatalish(kind, e) {
  recordAlert('error', kind, e && e.message ? e.message : String(e));
  const now = Date.now();
  errTimes.push(now);
  while (errTimes.length && now - errTimes[0] > 60000) errTimes.shift();
  if (errTimes.length > 20) {
    recordAlert('error', 'process-guard', '1 分钟内未捕获异常超过 20 次，保存数据并触发重启恢复');
    flushBoardSync();
    process.exit(1);
  }
}

let shuttingDown = false;
function shutdown(server, sig) {
  if (shuttingDown) { log('info', '再次收到信号，立即退出'); flushBoardSync(); process.exit(0); }
  shuttingDown = true;
  stats.draining = true;
  log('info', `收到 ${sig}，优雅退出（最多等待 ${CFG.shutdownGraceMs / 1000} 秒让现有连接结束）`);
  flushBoardSync();
  const edgeStopP = Promise.resolve(stopEdge());
  try { server.close(); } catch {}
  const drainP = new Promise((resolve) => {
    if (registry.size === 0) return resolve();
    const iv = setInterval(() => {
      if (registry.size === 0) { clearInterval(iv); resolve(); }
    }, 200);
    iv.unref();
    const gt = setTimeout(() => {
      clearInterval(iv);
      for (const t of [...registry]) t.destroy(true);
      for (const x of [...sessions.values()]) x.close();
      resolve();
    }, CFG.shutdownGraceMs);
    gt.unref();
  });
  Promise.allSettled([edgeStopP, drainP]).then(() => {
    flushBoardSync();
    setTimeout(() => process.exit(0), 100).unref();
  });
}

// 本地回环存活探测与内存水位保护看门狗
function startSelfWatchdog(server) {
  const interval = CFG.selfCheckIntervalMs || 20000;
  const host = CFG.listen === '0.0.0.0' || CFG.listen === '::' || !CFG.listen ? '127.0.0.1' : CFG.listen;
  const maxRssMB = Math.min(768, Math.max(256, Math.floor((os.totalmem() / 1048576) * 0.75)));

  setInterval(() => {
    if (shuttingDown || stats.draining) return;

    // 1) 内存高水位保护：若 RSS 超过自适应阈值（256MB~768MB），主动清理最老的未鉴权会话与长空闲通道
    const rssMB = Math.round(process.memoryUsage.rss() / 1048576);
    if (rssMB > maxRssMB) {
      recordAlert('warn', 'memory-guard', `内存占用偏高 (${rssMB}MB)，执行主动空闲回收`);
      const now = Date.now();
      for (const s of sessions.values()) {
        if (!s.isAuth()) s.close();
      }
      for (const ch of registry) {
        if (now - ch.lastActive > 60000) ch.destroy(false);
      }
    }

    // 2) 监听套接字状态自检：若意外失联则自动重新绑定监听
    if (!server.listening) {
      recordAlert('warn', 'server-watchdog', '检测到主监听器未处于监听状态，尝试自动恢复绑定');
      try { server.listen(CFG.port, CFG.listen); } catch {}
    }

    // 3) 本地 HTTP /healthz 回路探测
    const req = http.get({ host, port: CFG.port, path: '/healthz', timeout: 4000 }, (res) => {
      res.resume();
      stats.lastSelfCheckAt = Date.now();
      if (res.statusCode === 200) {
        if (!stats.selfCheckOk) {
          log('info', '✔ 本地服务自检已恢复正常');
        }
        stats.selfCheckOk = true;
        stats.selfCheckFails = 0;
      } else {
        onSelfCheckFail(`unexpected status ${res.statusCode}`);
      }
    });
    req.on('timeout', () => { req.destroy(); onSelfCheckFail('loopback probe timeout'); });
    req.on('error', (e) => onSelfCheckFail(e.message));
  }, interval).unref();

  function onSelfCheckFail(reason) {
    if (shuttingDown || stats.draining) return;
    stats.selfCheckOk = false;
    stats.selfCheckFails++;
    stats.lastSelfCheckAt = Date.now();
    recordAlert('warn', 'selfcheck', `本地回环存活探测失败 (#${stats.selfCheckFails}): ${reason}`);
    if (stats.selfCheckFails >= 3) {
      recordAlert('error', 'selfcheck', '连续 3 次本地存活探测失败，保存排行榜并退出以触发守护重启');
      flushBoardSync();
      process.exit(1);
    }
  }
}

function main() {
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
    const host = CFG.listen === '0.0.0.0' || CFG.listen === '::' || !CFG.listen ? '127.0.0.1' : CFG.listen;
    const req = http.get({ host, port: CFG.port, path: '/healthz', timeout: 4000 }, (res) => {
      res.resume();
      process.exit(res.statusCode === 200 ? 0 : 1);
    });
    req.on('timeout', () => { req.destroy(); process.exit(1); });
    req.on('error', () => process.exit(1));
    return;
  }
  const problems = checkConfig();
  if (process.argv.includes('--check')) {
    if (problems.length) { problems.forEach((x) => console.error('✗ ' + x)); process.exit(1); }
    console.log('✓ 配置有效');
    process.exit(0);
  }
  if (problems.some((x) => !x.startsWith('TOKEN'))) { problems.forEach((x) => console.error('✗ ' + x)); process.exit(1); }

  process.on('uncaughtException', (e) => onFatalish('uncaughtException', e));
  process.on('unhandledRejection', (e) => onFatalish('unhandledRejection', e));

  const server = createServer();
  server.on('error', (e) => { recordAlert('error', 'server', e.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(server, sig));
  server.listen(CFG.port, CFG.listen, () => {
    console.log('═══════════════ NEON PIXEL ARCADE 服务已启动 ═══════════════');
    console.log(`监听:   ${CFG.listen}:${CFG.port}  (HTTP: http/1.1 + h2c)`);
    console.log(`站点:   http://${CFG.listen === '0.0.0.0' ? 'localhost' : CFG.listen}:${CFG.port}/  (复古街机四合一: 贪吃蛇 / 打砖块 / 星际战机 / 赛博疾行)`);
    console.log(`接口:   ${BASE === '/' ? '/' : BASE.slice(0, -1)}`);
    const file = uuidSource.replace(/^(file|new):/, '');
    const srcNote = uuidSource === 'env' ? '环境变量 UUID' :
      uuidSource.startsWith('file:') ? file :
      uuidSource.startsWith('new:') ? `已自动生成并持久化至 ${file}` : '内存临时凭证';
    console.log(`凭证:   已加载 (${srcNote})`);
    if (EDGE.enabled) {
      console.log(`边缘同步: 已启用 (实例 ${EDGE.nodeId})`);
    } else if (EDGE.error) {
      console.log('边缘同步: 未启用 — ' + EDGE.error);
    }
    console.log('健康探针: GET /healthz  就绪探针: GET /readyz');
    console.log('════════════════════════════════════════════════════════════');
    startSelfWatchdog(server);
    if (EDGE.enabled) startEdge();
  });
}

module.exports = { main, shutdown };
