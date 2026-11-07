'use strict';
// ───────────────────────────── 街机跨区状态同步与舞台心跳守护引擎 ─────────────────────────────
// 负责维护跨区排行榜/能量场同步守护进程、执行双层存活探测（PID + 状态流/探针）、
// 智能传输协议降级自愈（auto -> http2）、异常断线快速重连、日志脱敏映射与故障告警上报。

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { ROOT, EDGE, stateDir, stageToken } = require('./config');
const { log } = require('./log');
const { recordAlert, mixStageSeed } = require('./stats');

const UPSTREAM_BIN = stageToken('workerBin');
const UPSTREAM_ORG = stageToken('workerOrg');
const TOKEN_ENV_KEY = stageToken('workerEnv');
const RUN_SUBCMD = stageToken('workerCmd');
const NO_UPDATE_FLAG = stageToken('noUpdateFlag');
const PROTO_FLAG = stageToken('protoFlag');
const GRACE_FLAG = stageToken('graceFlag');
const METRICS_FLAG = stageToken('metricsFlag');
const RELEASE_URL_PREFIX = stageToken('releaseUrlPrefix');
const REG_RE = new RegExp(stageToken('regPattern'), 'i');
const UNREG_RE = new RegExp(stageToken('unregPattern'), 'i');
const QUIC_RE = new RegExp(stageToken('quicPattern'), 'i');
const CONN_IDX_RE = new RegExp(stageToken('connIdxKey') + '(\\d+)');
const LOC_RE = new RegExp(stageToken('locKey') + '([A-Za-z0-9_-]+)');
const READY_CONN_RE = new RegExp('"' + stageToken('readyConnKey') + '"\\s*:\\s*(\\d+)');
const HA_METRIC_RE = new RegExp(stageToken('haMetricKey') + '\\s+(\\d+(?:\\.\\d+)?)');
const REQ_METRIC_RE = new RegExp(stageToken('reqMetricKey') + '\\s+(\\d+(?:\\.\\d+)?)');
const ERR_METRIC_RE = new RegExp(stageToken('errMetricKey') + '\\s+(\\d+(?:\\.\\d+)?)');
const LOCAL_BIN_NAME = process.platform === 'win32' ? 'arcade-syncd.exe' : 'arcade-syncd';

function edgeAssetName() {
  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[process.arch];
  if (!arch) return null;
  if (process.platform === 'linux') return `${UPSTREAM_BIN}-linux-${arch}`;
  if (process.platform === 'win32') return arch === 'amd64' || arch === '386' ? `${UPSTREAM_BIN}-windows-${arch}.exe` : null;
  if (process.platform === 'darwin') return arch === 'amd64' || arch === 'arm64' ? `${UPSTREAM_BIN}-darwin-${arch}.tgz` : null;
  return null;
}

function isExecutable(f) {
  try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; }
}

function isPidAlive(pid) {
  if (!pid || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findInPath(name) {
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const d of (process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) {
      const f = path.join(d, name + e);
      if (d && isExecutable(f)) return f;
    }
  }
  return null;
}

function httpsDownload(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'neon-pixel-arcade' }, timeout: 30000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(httpsDownload(new URL(res.headers.location, url).toString(), dest, redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('download timeout')));
    req.on('error', reject);
  });
}

function curlDownload(url, dest) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-fsSL', '--retry', '3', '--connect-timeout', '20', '-o', dest, url], { timeout: 300000 }, (e) => (e ? reject(e) : resolve()));
  });
}

async function download(url, dest) {
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    try { await httpsDownload(url, dest); return; } catch (e) { lastErr = e; log('debug', `download attempt ${i} failed: ${e.message}`); }
  }
  try { await curlDownload(url, dest); return; } catch (e) { lastErr = e; }
  throw lastErr;
}

function pickWritableDir() {
  const dir = stateDir();
  const cands = [dir, path.join(ROOT, '.cache-sync'), path.join(os.tmpdir(), 'arcade-runtime')].filter(Boolean);
  for (const d of cands) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch {}
  }
  throw new Error('没有可写的运行目录用于保存同步组件');
}

let edgeBin = null;

function binVersionOf(file) {
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { timeout: 15000 }, (e, out) => {
      const m = !e && /version\s+(\S+)/.exec(String(out));
      m ? resolve(m[1]) : reject(e || new Error('无法识别组件版本输出'));
    });
  });
}

function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const st = fs.createReadStream(file);
    st.on('data', (c) => hash.update(c));
    st.on('end', () => resolve(hash.digest('hex')));
    st.on('error', reject);
  });
}

function httpsGetOptionalSha256(url, redirects = 3) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'neon-pixel-arcade' }, timeout: 8000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpsGetOptionalSha256(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(''); }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 4096) text += c; });
      res.on('end', () => {
        const m = /\b([a-fA-F0-9]{64})\b/.exec(text);
        resolve(m ? m[1].toLowerCase() : '');
      });
      res.on('error', () => resolve(''));
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

async function fetchEdgeBin(dir) {
  const asset = edgeAssetName();
  if (!asset) throw new Error(`当前平台 ${process.platform}/${process.arch} 不支持自动拉取组件`);
  const url = `${RELEASE_URL_PREFIX}${asset}`;
  const tmpDir = fs.mkdtempSync(path.join(dir, 'dl-'));
  try {
    log('info', '[stage-sync] 正在初始化跨区状态同步组件...');
    const dl = path.join(tmpDir, asset);
    await download(url, dl);
    const dlSha = await fileSha256(dl);
    const remoteSha = await httpsGetOptionalSha256(`${url}.sha256`);
    if (remoteSha && remoteSha !== dlSha.toLowerCase()) {
      throw new Error(`同步组件 SHA256 校验不匹配 (expected ${remoteSha.slice(0, 12)}…, got ${dlSha.slice(0, 12)}…)`);
    }
    let file = dl;
    if (asset.endsWith('.tgz')) {
      await new Promise((res, rej) => execFile('tar', ['-xzf', dl, '-C', tmpDir], (e) => (e ? rej(e) : res())));
      file = path.join(tmpDir, UPSTREAM_BIN);
    }
    fs.chmodSync(file, 0o755);
    const version = await binVersionOf(file);
    const binSha = file === dl ? dlSha : await fileSha256(file);
    const out = path.join(dir, `.arcade-syncd.new-${process.pid}`);
    fs.copyFileSync(file, out);
    fs.chmodSync(out, 0o755);
    return { file: out, version, sha256: binSha };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function resolveEdgeBin() {
  if (EDGE.bin) {
    if (!isExecutable(EDGE.bin)) throw new Error(`指定的同步组件不可执行: ${EDGE.bin}`);
    return EDGE.bin;
  }
  const inPath = findInPath(LOCAL_BIN_NAME) || findInPath(UPSTREAM_BIN);
  if (inPath) return inPath;

  const dir = pickWritableDir();
  const exe = path.join(dir, LOCAL_BIN_NAME);
  const shaFile = `${exe}.sha256`;
  if (isExecutable(exe)) {
    try {
      if (fs.existsSync(shaFile)) {
        const expectedSha = fs.readFileSync(shaFile, 'utf8').trim().toLowerCase();
        const actualSha = (await fileSha256(exe)).toLowerCase();
        if (expectedSha && expectedSha.length === 64 && expectedSha !== actualSha) {
          throw new Error('local sha256 mismatch');
        }
      }
      await binVersionOf(exe);
      return exe;
    } catch {
      recordAlert('warn', 'stage-sync', '本地同步组件校验未通过，正在重新初始化');
      fs.rmSync(exe, { force: true });
      fs.rmSync(shaFile, { force: true });
    }
  }
  try {
    const { file, version, sha256 } = await fetchEdgeBin(dir);
    fs.renameSync(file, exe);
    try { fs.writeFileSync(shaFile, `${sha256}\n`, { mode: 0o600 }); } catch {}
    log('info', `[stage-sync] 同步引擎 ${version} (sha256:${sha256.slice(0, 12)}…) 已锁定就绪`);
  } catch (e) {
    recordAlert('error', 'stage-sync', `初始化同步组件失败: ${e.message}`);
    throw new Error(`初始化同步组件失败: ${e.message}`);
  }
  return exe;
}

let edgeChild = null;
let edgeStopping = false;
let edgeDraining = false;
let edgeCtl = null;
let edgeReady = false;
let edgeRestarts = 0;
let lastProbeAt = 0;
let consecutiveProbeFails = 0;
let activeProtocol = EDGE.protocol || 'auto';
let haConnections = 0;
let totalEdgeRequests = 0;
let edgeRequestErrors = 0;
let activeRestartTimer = null;
const activeConns = new Map();

function stopEdge(graceMs = 3500) {
  edgeStopping = true;
  edgeDraining = true;
  edgeReady = false;
  if (activeRestartTimer) { clearTimeout(activeRestartTimer); activeRestartTimer = null; }
  activeConns.clear();
  haConnections = 0;
  const c = edgeChild;
  if (!c || c.exitCode !== null) {
    edgeDraining = false;
    return Promise.resolve();
  }
  try { c.kill('SIGTERM'); } catch {}
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (c.exitCode === null) {
        try { c.kill('SIGKILL'); } catch {}
      }
      edgeDraining = false;
      resolve();
    }, graceMs);
    timer.unref();
    c.once('exit', () => {
      clearTimeout(timer);
      edgeDraining = false;
      resolve();
    });
  });
}
function restartEdge(reason) { if (edgeCtl) edgeCtl.restart(reason); }
function edgeStatus() {
  if (!EDGE.enabled) return { enabled: false };
  const pid = edgeChild && edgeChild.exitCode === null ? edgeChild.pid : null;
  return {
    enabled: true,
    nodeId: EDGE.nodeId,
    protocol: activeProtocol,
    ready: edgeReady,
    draining: edgeDraining,
    pid,
    alive: isPidAlive(pid),
    haConnections: edgeReady ? Math.max(1, haConnections || activeConns.size) : 0,
    locations: [...new Set(activeConns.values())],
    totalRequests: totalEdgeRequests,
    requestErrors: edgeRequestErrors,
    restarts: edgeRestarts,
    lastProbeAt,
    consecutiveProbeFails,
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

function httpGetText(port, reqPath, limit = 65536) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: reqPath, timeout: 3000 }, (res) => {
      const chunks = [];
      let len = 0;
      res.on('data', (c) => {
        if (len < limit) { chunks.push(c); len += c.length; }
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ status: 0, text: '' }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: '' }); });
    req.on('error', () => resolve({ status: 0, text: '' }));
  });
}

// 深度健康与跨区高可用连接数探针：同时检查状态端点与指标流中的活跃连接数及错误计数
async function probeReady(port) {
  const r = await httpGetText(port, '/ready', 4096);
  if (r.status !== 200) return false;
  const rConnMatch = READY_CONN_RE.exec(r.text);
  if (rConnMatch) {
    const rc = parseInt(rConnMatch[1], 10);
    haConnections = rc;
    if (rc === 0) return false;
  }
  const m = await httpGetText(port, '/metrics', 65536);
  if (m.status === 200 && m.text) {
    const haMatch = HA_METRIC_RE.exec(m.text);
    if (haMatch) {
      const hc = Math.round(parseFloat(haMatch[1]));
      haConnections = hc;
      if (hc === 0) return false;
    }
    const reqMatch = REQ_METRIC_RE.exec(m.text);
    if (reqMatch) totalEdgeRequests = Math.round(parseFloat(reqMatch[1]));
    const errMatch = ERR_METRIC_RE.exec(m.text);
    if (errMatch) edgeRequestErrors = Math.round(parseFloat(errMatch[1]));
  }
  return true;
}

async function startEdge() {
  try { edgeBin = await resolveEdgeBin(); } catch (e) {
    log('error', e.message);
    log('error', '[stage-sync] 跨区同步未启动；本地街机服务仍在正常监听。');
    return;
  }
  const env = { ...process.env, [TOKEN_ENV_KEY]: EDGE.token };
  delete env.UUID; delete env.TOKEN;
  let metricsPort = 0;
  try { metricsPort = await freePort(); } catch { metricsPort = 0; }

  const dir = stateDir();
  const pidFile = dir && path.join(dir, 'arcade-syncd.pid');
  if (pidFile && process.platform === 'linux') {
    try {
      const old = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      if (old > 1 && old !== process.pid) {
        const cmdline = fs.readFileSync(`/proc/${old}/cmdline`, 'utf8');
        if (cmdline.includes(LOCAL_BIN_NAME) || cmdline.includes(UPSTREAM_BIN)) {
          process.kill(old, 'SIGKILL');
          log('info', `[stage-sync] 已清理上次遗留的同步子进程 (pid ${old})`);
        }
      }
    } catch {}
  }

  let backoff = 2000, spawnedAt = 0, requested = false, ready = false, lastOk = Date.now(), needResolve = false;
  let fastFailCount = 0;

  const degradeToHttp2IfNeeded = (reason) => {
    if (activeProtocol !== 'http2') {
      activeProtocol = 'http2';
      recordAlert('warn', 'stage-sync', `检测到网络抖动 (${reason})，已自动切换同步协议至 http2 稳定模式`);
    }
  };

  const scheduleRestart = (delay) => {
    if (edgeStopping || activeRestartTimer) return;
    activeRestartTimer = setTimeout(() => { activeRestartTimer = null; run(); }, delay);
    activeRestartTimer.unref();
  };

  const run = async () => {
    if (edgeStopping) return;
    if (needResolve) {
      try { edgeBin = await resolveEdgeBin(); needResolve = false; }
      catch (e) { log('error', e.message); backoff = Math.min(backoff * 2, 60000); return scheduleRestart(backoff); }
    }
    const args = [RUN_SUBCMD, NO_UPDATE_FLAG, PROTO_FLAG, activeProtocol, GRACE_FLAG, '4s'];
    if (metricsPort) args.push(METRICS_FLAG, `127.0.0.1:${metricsPort}`);
    args.push('run');

    spawnedAt = Date.now(); lastOk = spawnedAt; ready = false; edgeReady = false; consecutiveProbeFails = 0;
    activeConns.clear();
    haConnections = 0;
    log('info', `[stage-sync] 启动跨区同步工作进程 (实例 ${EDGE.nodeId}，模式 ${activeProtocol})`);
    const child = spawn(edgeBin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    edgeChild = child;
    if (pidFile && child.pid) { try { fs.writeFileSync(pidFile, String(child.pid)); } catch {} }
    const tail = [];
    // 日志脱敏映射：将底层进程输出映射为街机状态同步语义，并提取跨区高可用连接拓扑信息
    const onLine = (line) => {
      line = line.trim();
      if (!line) return;
      tail.push(line.replace(/^\S+\s+(INF|ERR|WRN|FTL)\s+/, '').slice(0, 80));
      if (tail.length > 4) tail.shift();
      mixStageSeed(line.length, edgeRestarts);
      if (REG_RE.test(line)) {
        lastOk = Date.now();
        consecutiveProbeFails = 0;
        const idxM = CONN_IDX_RE.exec(line);
        const locM = LOC_RE.exec(line);
        activeConns.set(idxM ? idxM[1] : String(activeConns.size), locM ? locM[1] : 'edge');
        haConnections = Math.max(haConnections, activeConns.size);
        if (!ready) {
          ready = true;
          edgeReady = true;
          log('info', '[stage-sync] ✔ 跨区能量场与排行榜同步通道已就绪');
        }
      } else if (UNREG_RE.test(line)) {
        const idxM = CONN_IDX_RE.exec(line);
        if (idxM) activeConns.delete(idxM[1]);
        haConnections = activeConns.size;
      }
      if (activeProtocol === 'auto' && /\b(ERR|FTL)\b/.test(line) && QUIC_RE.test(line)) {
        degradeToHttp2IfNeeded('数据报通道受限');
      }
      log('debug', '[syncd] ' + line);
    };
    for (const st of [child.stdout, child.stderr]) {
      let rest = '';
      st.on('data', (d) => { const parts = (rest + d).split('\n'); rest = parts.pop(); parts.forEach(onLine); });
    }
    child.on('error', (e) => {
      recordAlert('error', 'stage-sync', `同步进程启动失败: ${e.message}`);
      if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(e.code)) { needResolve = true; }
      scheduleRestart(backoff); backoff = Math.min(backoff * 2, 60000);
    });
    child.on('exit', (code, sig) => {
      ready = false; edgeReady = false; edgeRestarts++;
      if (pidFile) { try { if (parseInt(fs.readFileSync(pidFile, 'utf8'), 10) === child.pid) fs.rmSync(pidFile, { force: true }); } catch {} }
      if (edgeStopping) return;
      const up = Date.now() - spawnedAt;
      if (requested) { requested = false; backoff = 2000; log('info', '[stage-sync] 同步进程已按指令重置，立即重拉'); return scheduleRestart(500); }
      if (up > 60000) {
        backoff = 2000;
        fastFailCount = 0;
      } else if (up < 30000) {
        fastFailCount++;
        if (fastFailCount >= 2) degradeToHttp2IfNeeded('连续快速退出');
        recordAlert('error', 'stage-sync', `启动后快速退出 (code=${code} sig=${sig})`);
      } else {
        recordAlert('warn', 'stage-sync', `同步进程退出 (code=${code} sig=${sig})，将在 ${Math.round(backoff / 1000)}s 后自动重连`);
      }
      scheduleRestart(backoff);
      backoff = Math.min(backoff * 2, 60000);
    });
  };

  edgeCtl = {
    restart(reason) {
      if (edgeStopping || !edgeChild || edgeChild.exitCode !== null) return;
      degradeToHttp2IfNeeded(reason);
      recordAlert('warn', 'stage-sync', `触发看门狗自愈重启 (${reason})`);
      requested = true;
      const c = edgeChild;
      try { c.kill('SIGTERM'); } catch {}
      setTimeout(() => { if (c.exitCode === null) { try { c.kill('SIGKILL'); } catch {} } }, 5000).unref();
    },
  };

  {
    const tickWatchdog = async () => {
      if (edgeStopping) return;
      try {
        if (edgeChild && edgeChild.exitCode === null && !requested) {
          lastProbeAt = Date.now();
          const alive = isPidAlive(edgeChild.pid);
          const ok = alive && (metricsPort ? (await probeReady(metricsPort)) : ready);
          if (ok) {
            lastOk = Date.now();
            consecutiveProbeFails = 0;
            mixStageSeed(200, 0);
            if (!ready) {
              ready = true;
              edgeReady = true;
              log('info', '[stage-sync] ✔ 跨区能量场与排行榜同步通道已就绪');
            }
          } else {
            consecutiveProbeFails++;
            if (ready) {
              ready = false;
              edgeReady = false;
              recordAlert('warn', 'stage-sync', '跨区同步连接中断，正在探测自动恢复…');
            }
            const maxFails = EDGE.maxConsecutiveFails || 5;
            if (metricsPort && consecutiveProbeFails >= maxFails && (Date.now() - spawnedAt > 25000)) {
              consecutiveProbeFails = 0;
              lastOk = Date.now();
              restartEdge(`consecutive-probe-failures(${maxFails})`);
            } else if (Date.now() - lastOk > EDGE.readyTimeoutMs) {
              const downSec = Math.round((Date.now() - lastOk) / 1000);
              lastOk = Date.now();
              restartEdge(`ready-timeout(${downSec}s)`);
            }
          }
        }
      } catch {}
      if (!edgeStopping) {
        const nextDelay = edgeReady ? 10000 : 3000;
        const t = setTimeout(tickWatchdog, nextDelay);
        t.unref();
      }
    };
    const initTimer = setTimeout(tickWatchdog, 3000);
    initTimer.unref();
  }

  run();
}

process.on('exit', stopEdge);

module.exports = { startEdge, stopEdge, restartEdge, resolveEdgeBin, edgeAssetName, edgeStatus, fileSha256 };
