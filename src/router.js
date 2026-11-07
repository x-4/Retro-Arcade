'use strict';
// 路由与状态同步网关：静态资源服务、街机遥测 API、分包上行 (packet-up) / 流式同步 (stream-up / stream-one)

const http2 = require('http2');
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { CFG, BASE, USERS, EDGE, stageToken } = require('./config');
const { log } = require('./log');
const { stats } = require('./stats');
const { isBanned, safeEq } = require('./security');
const { isPrivateIP } = require('./netutil');
const { Channel, registry } = require('./channel');
const { closedSessions, sessions, upsertSession } = require('./session');
const { snapshot, prometheusMetrics, renderAdminHtml } = require('./monitor');
const { getPulseBuffer, recordScore, recordTelemetry } = require('./arcade');

// ───────────────────────────── 静态站点（复古街机前端，带异步内存缓存 + ETag + Gzip） ─────────────────────────────

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.svg', '.txt']);
const staticCache = new Map();

async function getStaticEntry(full, ext) {
  const st = await fs.promises.stat(full);
  if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
  const cached = staticCache.get(full);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
  const raw = await fs.promises.readFile(full);
  const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
  const etag = `"${hash}"`;
  const gz = COMPRESSIBLE.has(ext) && raw.length >= 256 ? zlib.gzipSync(raw, { level: 6 }) : null;
  const entry = { mtimeMs: st.mtimeMs, size: st.size, raw, gz, etag, ext };
  if (staticCache.size > 128) staticCache.delete(staticCache.keys().next().value);
  staticCache.set(full, entry);
  return entry;
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!CFG.webDir) return false;
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return false; }
  if (rel === '/') rel = '/index.html';
  const root = path.resolve(CFG.webDir);
  const full = path.resolve(root, '.' + rel);
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  try {
    const ext = path.extname(full).toLowerCase();
    const entry = await getStaticEntry(full, ext);
    if (!entry) return false;
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', (ext === '.html' || rel === '/sw.js') ? 'no-cache' : 'public, max-age=3600');
    if (rel === '/sw.js') res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('ETag', entry.etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ext === '.html') {
      res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'");
    }
    if (req.headers['if-none-match'] === entry.etag) {
      res.statusCode = 304;
      res.end();
      return true;
    }
    const acceptGz = entry.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
    const body = acceptGz ? entry.gz : entry.raw;
    if (acceptGz) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
    }
    res.setHeader('Content-Length', body.length);
    res.statusCode = 200;
    if (req.method === 'HEAD') { res.end(); return true; }
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// ───────────────────────────── HTTP 帧与会话提取 ─────────────────────────────

const SESSION_KEYS = stageToken('sessKeys').split(',');
const SEQ_KEYS = stageToken('seqKeys').split(',');
const DATA_KEYS = stageToken('dataKeys').split(',');
const PAD_HEADER = stageToken('padHeader');
const CF_IP_HEADER = stageToken('cfIpHeader');
const CF_RAY_HEADER = stageToken('cfRayHeader');
const CLIENT_UA_RE = new RegExp(stageToken('clientUaPattern'), 'i');

function parseCookies(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// 提取会话标识与帧序号，支持 path / query / header / cookie 四种位置（兼容 /api/v1/telemetry/<sid>/<seq> 复用路径）
function extractMeta(req, rest, query) {
  const sub = rest.split('/');
  let p = sub[0] === 'telemetry' ? 1 : 0;
  let session = '', seq = '';
  const qs = new URLSearchParams(query);
  const cookies = parseCookies(req.headers.cookie);

  for (const k of SESSION_KEYS) {
    session = qs.get(k) || req.headers[k.toLowerCase()] || cookies[k] || '';
    if (session) break;
  }
  if (!session && sub.length > p && sub[p]) { session = sub[p]; p++; }
  else if (session && sub[0] === '' && sub.length === 1) { /* 会话在 query/header/cookie */ }

  for (const k of SEQ_KEYS) {
    seq = qs.get(k) || req.headers[k.toLowerCase()] || cookies[k] || '';
    if (seq) break;
  }
  if (!seq && sub.length > p && sub[p]) { seq = sub[p]; p++; }
  return { session, seq };
}

function extractHeaderPayload(req) {
  const cookies = parseCookies(req.headers.cookie);
  for (const key of DATA_KEYS) {
    const chunks = [];
    for (let i = 0; req.headers[`${key.toLowerCase()}-${i}`]; i++) chunks.push(req.headers[`${key.toLowerCase()}-${i}`]);
    if (chunks.length) return Buffer.from(chunks.join(''), 'base64url');
    for (let i = 0; cookies[`${key}_${i}`]; i++) chunks.push(cookies[`${key}_${i}`]);
    if (chunks.length) return Buffer.from(chunks.join(''), 'base64url');
  }
  return null;
}

// 自适应微批写聚合器（Micro-Batch Downlink Coalescing）：
// 大块数据（>=32KB）直接零拷贝直写；同事件循环微任务内的高频小包自动聚合并通过 cork/uncork 合并写出，0ms 额外定时器延迟
function makeDown(res) {
  let q = [];
  let qBytes = 0;
  let scheduled = false;
  let backpressured = false;

  const flush = () => {
    scheduled = false;
    if (!q.length || res.destroyed || res.writableEnded) {
      q = [];
      qBytes = 0;
      return;
    }
    const payload = q.length === 1 ? q[0] : Buffer.concat(q, qBytes);
    q = [];
    qBytes = 0;
    try {
      if (typeof res.cork === 'function') res.cork();
      backpressured = !res.write(payload);
      if (typeof res.uncork === 'function') res.uncork();
    } catch {
      backpressured = false;
    }
  };

  return {
    write(b) {
      if (res.destroyed || res.writableEnded) return true;
      if (!b || !b.length) return !backpressured;
      if (q.length === 0 && b.length >= 32768) {
        try {
          backpressured = !res.write(b);
          return !backpressured;
        } catch {
          return true;
        }
      }
      q.push(b);
      qBytes += b.length;
      if (qBytes >= 32768) {
        flush();
      } else if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
      return !backpressured && qBytes < 65536;
    },
    drain(fn) {
      res.once('drain', () => {
        backpressured = false;
        fn();
      });
    },
    end() {
      try {
        if (q.length) flush();
        if (!res.writableEnded) res.end();
      } catch {}
    },
    destroy() {
      q = [];
      qBytes = 0;
      try {
        if (res.stream) {
          const st = res.stream;
          // 僵死流（closed=true 但 destroyed=false）上 close() 是空操作，必须 destroy() 才能真正释放
          if (!st.destroyed) { st.destroy(); }
        }
        else if (res.socket) res.socket.destroy();
        else res.destroy();
      } catch {}
    },
  };
}

async function readBody(req, limit) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(c);
  }
  return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
}

// 流式上行：把请求体持续泵入实时通道（stream-one / stream-up）
async function pumpBody(req, channel) {
  try {
    for await (const c of req) await channel.push(c);
    channel.endUplink();
  } catch (e) {
    log('debug', `${channel.label} uplink ended: ${e.message}`);
    channel.destroy(false);
    killStream(req);
  } finally {
    req.on('error', () => {});
    drain(req); // 通道已结束但客户端还在上传时，把剩余数据读空丢弃，让流能正常收尾
  }
}

// 丢弃请求体的剩余数据。h2 兼容层在 req 背压时会暂停底层 stream；而 for-await 提前退出会销毁 req，
// 之后 req.resume() 不再生效，底层 stream 永远没人恢复 → 流/会话/TCP 连接一起滞留。所以必须直接恢复底层 stream。
function drain(req) {
  try { req.resume(); } catch {}
  try { if (req.stream && !req.stream.destroyed) req.stream.resume(); } catch {}
}

// 注意：不要对仍在上传的 h2 流调用 close(NGHTTP2_CANCEL)——Node 22 的 http2 在此情形下会进入原生发送死循环，
// 内存数秒内涨到数 GB 并 std::bad_alloc 崩溃；统一用 stream.destroy()。
function killStream(req) {
  drain(req);
  const st = req.stream;
  try {
    if (st) { if (!st.destroyed) { st.destroy(); } }
    else if (req.socket) req.socket.destroy(); // h1：请求体没读完的连接不能复用，直接断开
  } catch {}
}

// "客户端已离开"的统一信号。
function onGone(req, res, fn) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    killStream(req);
    fn();
  };
  res.on('close', once);
  req.on('aborted', once);
  if (req.stream) req.stream.on('aborted', once);
}

function respond(res, code, body) {
  if (res.headersSent) return;
  res.statusCode = code;
  if (body) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(body);
  } else {
    res.end();
  }
}

let paddingRing = crypto.randomBytes(1536).toString('base64url');
setInterval(() => { paddingRing = crypto.randomBytes(1536).toString('base64url'); }, 300000).unref();
function paddingValue() {
  const len = 96 + Math.floor(Math.random() * 800);
  const off = Math.floor(Math.random() * Math.max(1, paddingRing.length - len));
  return 'st-' + paddingRing.slice(off, off + len);
}

function clientIp(req) {
  const direct = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (isPrivateIP(direct)) {
    const cf = String(req.headers[CF_IP_HEADER] || '').trim();
    if (net.isIP(cf)) return cf;
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (net.isIP(real)) return real;
    const xff = String(req.headers['x-forwarded-for'] || '');
    for (const part of xff.split(',')) {
      const candidate = part.trim();
      if (net.isIP(candidate)) return candidate;
    }
  }
  return direct;
}

// 全局共享的街机 SSE 广播池（O(1) 单定时器驱动所有在线观战/游戏客户端，上限 256 个连接）
const sseClients = new Set();
const MAX_SSE_CLIENTS = 256;
setInterval(() => {
  if (sseClients.size === 0) return;
  const frame = Buffer.concat([Buffer.from('data: '), getPulseBuffer(), Buffer.from('\n\n')]);
  for (const res of sseClients) {
    if (res.destroyed || res.writableEnded) { sseClients.delete(res); continue; }
    stats.down += frame.length;
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}, 3000).unref();

// 街机游戏实时状态流、遥测帧上报与排行榜 API（与底层数据流同构，共享 /api/v1/* 及 <BASE>/* 路由特征）
async function handleArcadeApi(req, res, pathname, query) {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : null;

  // 1) 实时能量脉冲 SSE 事件流（GET /api/v1/events 或 <BASE>events）：与下行流共享 text/event-stream 与 X-Padding
  const isEvents = pathname === '/api/v1/events' || pathname === '/api/arcade/events' || rest === 'events';
  if (isEvents && req.method === 'GET') {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      const oldest = sseClients.values().next().value;
      if (oldest) { sseClients.delete(oldest); try { oldest.end(); } catch {} }
    }
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader(PAD_HEADER, paddingValue());
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/event-stream');
    res.statusCode = 200;
    res.flushHeaders();
    const firstFrame = Buffer.concat([Buffer.from('data: '), getPulseBuffer(), Buffer.from('\n\n')]);
    stats.down += firstFrame.length;
    try { res.write(firstFrame); } catch {}
    sseClients.add(res);
    onGone(req, res, () => sseClients.delete(res));
    return true;
  }

  // 2) 游戏状态快照查询（GET /api/v1/state）
  const isState = pathname === '/api/v1/state' || pathname === '/api/v1/leaderboard' || pathname === '/api/arcade/state' ||
    rest === 'state' || rest === 'leaderboard' || (rest === '' && req.method === 'GET' && /(^|&)mode=state(&|$)/.test(query));
  if (isState && (req.method === 'GET' || req.method === 'HEAD')) {
    const buf = getPulseBuffer();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(PAD_HEADER, paddingValue());
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', buf.length);
    res.end(req.method === 'HEAD' ? undefined : buf);
    return true;
  }

  // 3) 玩家实时操作帧遥测上报（POST /api/v1/telemetry[/<sid>/<seq>]）：支持 JSON 遥测与二进制数据流同路复用
  const isTelemetry = (
    pathname === '/api/v1/telemetry' || pathname.startsWith('/api/v1/telemetry/') ||
    rest === 'telemetry' || (rest && rest.startsWith('telemetry/'))
  ) && req.method === 'POST';
  if (isTelemetry) {
    const meta = extractMeta(req, rest !== null ? rest : pathname.replace(/^\/api\/v1\//, ''), query);
    if (!meta.session || !sessions.has(meta.session)) {
      const raw = await readBody(req, CFG.maxPost);
      if (raw.length === 0 || raw[0] === 0x7b) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader(PAD_HEADER, paddingValue());
        recordTelemetry(raw, clientIp(req));
        res.setHeader('Cache-Control', 'no-store');
        respond(res, 200);
        return true;
      }
      req._preReadBody = raw;
    }
  }

  // 4) 排行榜高分提交（POST /api/v1/score）
  const isScore = (pathname === '/api/v1/score' || pathname === '/api/arcade/score' || rest === 'score') && req.method === 'POST';
  if (isScore) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(PAD_HEADER, paddingValue());
    const raw = await readBody(req, 4096);
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { respond(res, 400); return true; }
    const out = recordScore(body && body.game, body && body.name, body && body.score, clientIp(req));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = out.ok ? 200 : (out.status || 400);
    res.end(JSON.stringify(out));
    return true;
  }
  return false;
}


function handler(req, res) {
  req.on('error', () => {});
  res.on('error', () => {});
  handleRequest(req, res).catch((e) => {
    log('debug', 'handler error', e && e.message);
    killStream(req);
    if (!res.headersSent) respond(res, e && e.status ? e.status : 500);
    else if (res.stream) res.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    else if (res.socket) res.socket.destroy();
  });
}

async function handleRequest(req, res) {
  const url = req.url || '/';
  const qi = url.indexOf('?');
  const pathname = qi < 0 ? url : url.slice(0, qi);
  const query = qi < 0 ? '' : url.slice(qi + 1);

  if (pathname === '/healthz') return respond(res, 200, 'ok');
  if (pathname === '/readyz') {
    if (stats.draining) return respond(res, 503, 'draining');
    if (registry.size >= CFG.maxChannels) return respond(res, 503, 'overloaded');
    return respond(res, 200, 'ready');
  }
  if (pathname.startsWith('/api/v1/metrics/')) {
    if (req.method !== 'GET') return respond(res, 404);
    const statUser = USERS.find((u) => safeEq(pathname, '/api/v1/metrics/' + u.text));
    if (!statUser) return respond(res, 404);
    res.setHeader('Cache-Control', 'no-store');
    if (/(^|&)format=prometheus(&|$)/.test(query) || /\btext\/plain\b/.test(String(req.headers.accept || ''))) {
      res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
      return res.end(prometheusMetrics());
    }
    res.setHeader('Content-Type', 'application/json');
    const out = snapshot();
    if (/(^|&)detail=1(&|$)/.test(query)) { // 列出当前活跃通道（最多 100 条，按存活时间排序）
      const now = Date.now();
      const list = [...registry].sort((a, b) => a.createdAt - b.createdAt).slice(0, 100).map((t) => ({
        who: t.label, state: t.state, ageSec: Math.round((now - t.createdAt) / 1000), idleSec: Math.round((now - t.lastActive) / 1000),
        remote: t.remote ? `${t.remote.remoteAddress}:${t.remote.remotePort}` : null, mux: t.mux.size,
      }));
      out.channels = list;
    }
    return res.end(JSON.stringify(out, null, 2));
  }

  // 内嵌式复古像素监控面板：GET /api/v1/console/<UUID>
  if (pathname.startsWith('/api/v1/console/')) {
    if (req.method !== 'GET') return respond(res, 404);
    const adminUser = USERS.find((u) => safeEq(pathname, '/api/v1/console/' + u.text));
    if (!adminUser) return respond(res, 404);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self';");
    return res.end(renderAdminHtml(adminUser.text));
  }

  // 唯一客户端联机档案导出入口：GET /api/v1/profile/<UUID>（移除其余路径与查询参数，仅依据 User-Agent 智能识别客户端类型）
  if (pathname.startsWith('/api/v1/profile/')) {
    if (req.method !== 'GET') return respond(res, 404);
    const subUser = USERS.find((u) => safeEq(pathname, '/api/v1/profile/' + u.text));
    if (!subUser) return respond(res, 404);
    {
      const rawHost = String(req.headers['x-forwarded-host'] || req.headers[':authority'] || req.headers.host || '127.0.0.1').split(',')[0].trim();
      let host = rawHost;
      let explicitPort = 0;
      if (rawHost.startsWith('[')) {
        const closeIdx = rawHost.indexOf(']');
        if (closeIdx > 0) {
          host = rawHost.slice(1, closeIdx);
          if (rawHost[closeIdx + 1] === ':') explicitPort = parseInt(rawHost.slice(closeIdx + 2), 10) || 0;
        }
      } else {
        const colonIdx = rawHost.lastIndexOf(':');
        if (colonIdx > 0 && /^\d+$/.test(rawHost.slice(colonIdx + 1))) {
          host = rawHost.slice(0, colonIdx);
          explicitPort = parseInt(rawHost.slice(colonIdx + 1), 10) || 0;
        }
      }
      const isLocalHost = host === 'localhost' || isPrivateIP(host);
      const hasEdgeHeader = Boolean(req.headers[CF_RAY_HEADER] || req.headers[CF_IP_HEADER]);
      const isEdge = hasEdgeHeader || (EDGE.enabled && !isLocalHost);
      const forwardedHttps = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
      const useTls = isEdge || forwardedHttps || explicitPort === 443;
      const port = explicitPort || (useTls ? 443 : CFG.port);
      const primaryMode = isEdge ? 'packet-up' : 'auto';
      const altMode = primaryMode === 'packet-up' ? 'auto' : 'packet-up';
      const modes = [[primaryMode, ''], [altMode, 'backup']];
      const protoScheme = stageToken('scheme');
      const protoName = protoScheme.replace(/:\/\/$/, '');
      const transportType = stageToken('transport');
      const basePath = BASE === '/' ? '/' : BASE.slice(0, -1);
      const baseName = 'neon-arcade';
      const ua = String(req.headers['user-agent'] || '');

      if (CLIENT_UA_RE.test(ua)) {
        const proxyBlocks = [];
        const proxyNames = [];
        const tlsSnippet = stageToken('yamlItemTls').replace('__HOST__', JSON.stringify(host));
        const extraSnippet = stageToken('yamlExtraBlock');

        for (const [m, suffix] of modes) {
          const itemName = suffix ? `${baseName}-${suffix}` : baseName;
          proxyNames.push(itemName);
          const block = [
            `  - name: ${JSON.stringify(itemName)}`,
            `    type: ${protoName}`,
            `    server: ${JSON.stringify(host)}`,
            `    port: ${port}`,
            `    uuid: ${JSON.stringify(subUser.text)}`,
            '    udp: true',
            `    tls: ${useTls}`,
          ];
          if (useTls) block.push(tlsSnippet);
          block.push(
            `    network: ${transportType}`,
            `    ${transportType}-opts:`,
            `      path: ${JSON.stringify(basePath)}`,
            `      host: ${JSON.stringify(host)}`,
            `      mode: ${m}`,
            extraSnippet
          );
          proxyBlocks.push(block.join('\n'));
        }

        const nameLines = proxyNames.map((n) => `      - ${JSON.stringify(n)}`).join('\n');
        const yamlText = [
          stageToken('yamlTop'),
          proxyBlocks.join('\n'),
          stageToken('yamlBottom').replace(/__NAMES__/g, nameLines),
        ].join('\n');

        res.setHeader('Cache-Control', 'no-store');
        res.setHeader(PAD_HEADER, paddingValue());
        res.setHeader('profile-update-interval', '24');
        res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
        return res.end(yamlText);
      }

      const epHost = host.includes(':') ? `[${host}]` : host;
      const lines = modes.map(([m, suffix]) => {
        const q = new URLSearchParams({
          encryption: 'none',
          security: useTls ? 'tls' : 'none',
          type: transportType,
          path: basePath,
          mode: m,
        });
        if (useTls) {
          q.set('sni', host);
          q.set('host', host);
        }
        const tag = encodeURIComponent(suffix ? `${baseName}-${suffix}` : baseName);
        return `${protoScheme}${subUser.text}@${epHost}:${port}?${q.toString()}#${tag}`;
      });
      const payloadText = lines.join('\n') + '\n';
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader(PAD_HEADER, paddingValue());
      res.setHeader('profile-update-interval', '24');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(Buffer.from(payloadText, 'utf8').toString('base64'));
    }
  }

  if (await handleArcadeApi(req, res, pathname, query)) return;

  const inBase = pathname.startsWith(BASE) || pathname + '/' === BASE;
  if (!inBase) {
    // 静态街机前端或健康检查兜底
    if (await serveStatic(req, res, pathname)) return;
    if (pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) return respond(res, 200, 'OK');
    return respond(res, 404);
  }

  // 统一同步网关响应头：CORS + 随机长度状态头
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader(PAD_HEADER, paddingValue());
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', req.headers['access-control-request-method'] || '*');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    return respond(res, 200);
  }

  const rest = pathname.slice(BASE.length);
  const { session: sid, seq } = extractMeta(req, rest, query);
  if (sid.length > 128) return respond(res, 400);
  const ip = clientIp(req);
  const label = `[${ip || '?'}${sid ? ' ' + sid.slice(0, 8) : ''}]`;
  if (isBanned(ip)) { stats.rejected++; return respond(res, 404); }
  if (sid && closedSessions.has(sid)) return respond(res, 410);

  // —— 上行请求：分包上行 packet-up（有 seq）/ 流式上行 stream-up（POST 无 seq）
  if (req.method === 'GET' && seq !== '' && !/^\d+$/.test(seq)) return respond(res, 404);
  const isUplink = req.method !== 'GET' || (sid && seq !== '');
  if (sid && isUplink) {
    let seqNum = 0;
    if (seq !== '') {
      seqNum = Number(seq);
      if (!/^\d+$/.test(seq) || !Number.isSafeInteger(seqNum)) return respond(res, 400);
    }
    const s = upsertSession(sid);
    if (!s) return respond(res, 503);

    if (seq === '') { // stream-up
      if (s.streamUp || s.nextSeq > 0 || s.pending.size) return respond(res, 409);
      s.streamUp = true;
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Cache-Control', 'no-store');
      res.statusCode = 200;
      res.flushHeaders();
      onGone(req, res, () => { if (!res.writableFinished) s.close(); });
      try { await s.whenAttached(); } catch { killStream(req); return res.end(); }
      if (!s.channel || s.channel.dead) { killStream(req); return res.end(); } // 会话在等到下行连接之前就已关闭
      await pumpBody(req, s.channel);
      res.end();
      return;
    }

    // packet-up
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > CFG.maxPost) return respond(res, 413);
    const reserve = declared || 65536;
    try { await s.admit(seqNum, reserve); } catch { return respond(res, 500); }
    let payload;
    try {
      payload = extractHeaderPayload(req);
      if (req.method !== 'GET') {
        const body = req._preReadBody !== undefined ? req._preReadBody : await readBody(req, CFG.maxPost);
        payload = payload ? Buffer.concat([payload, body]) : body;
      }
      payload = payload || Buffer.alloc(0);
      await s.push(seqNum, payload);
    } catch (e) {
      log('debug', `${label} upload failed: ${e.message}`);
      return respond(res, e && e.status ? e.status : 500);
    } finally {
      s.release(reserve);
    }
    if (!payload.length) res.setHeader('Cache-Control', 'no-store');
    return respond(res, 200);
  }

  // —— 下行请求：GET /<sid>（packet-up / stream-up 的下行事件流）
  if (sid && req.method === 'GET') {
    if (registry.size >= CFG.maxChannels) { stats.rejected++; return respond(res, 503); }
    const s = upsertSession(sid);
    if (!s) return respond(res, 503);
    if (s.channel) return respond(res, 409);
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/event-stream');
    res.statusCode = 200;
    res.flushHeaders();
    const channel = new Channel(makeDown(res), label, ip);
    s.attach(channel);
    log('debug', `${label} downlink opened`);
    onGone(req, res, () => { log('debug', `${label} downlink closed`); channel.destroy(false); s.close(); });
    return;
  }

  // —— 双向流模式 stream-one：POST /<base>，同一个请求既上行又下行
  if (!sid && req.method === 'POST') {
    if (registry.size >= CFG.maxChannels) { stats.rejected++; return respond(res, 503); }
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/event-stream');
    res.statusCode = 200;
    res.flushHeaders();
    const channel = new Channel(makeDown(res), label, ip);
    onGone(req, res, () => channel.destroy(false));
    await pumpBody(req, channel);
    return;
  }

  // 其它（如 BASE 设为 / 时浏览器直接访问无会话的 GET/HEAD）：优先展示街机前端静态页，兜底返回 OK
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (await serveStatic(req, res, pathname)) return;
    return respond(res, 200, 'OK');
  }
  return respond(res, 405);
}

module.exports = { handler, handleRequest, extractMeta, extractHeaderPayload, clientIp };
