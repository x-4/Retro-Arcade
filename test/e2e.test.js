'use strict';
// 全链路工业级回归测试套件：
// 覆盖流式同步协议 (h1/h2c, TCP/UDP/Mux) + 静态缓存/Gzip/ETag + 街机能量场/SSE/遥测帧与限流 + SSRF 防护 +
// 暴力破解封禁 + 会话墓碑 410 + Prometheus 指标 + /readyz 探针 + 边缘同步守护与 SHA256 校验
const { spawn } = require('child_process');
const net = require('net');
const dgram = require('dgram');
const http = require('http');
const http2 = require('http2');
const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { ChunkList, isPrivateIP, encodeAddrPort, parseAddrPort, connectTcp, resolveHost, lookupAll, dnsCache } = require('../src/netutil');
const { noteAuthFail, isBanned, authFails } = require('../src/security');
const { CFG, extractToken, stageToken, checkConfig } = require('../src/config');
const { Session, getTotalReserved } = require('../src/session');
const { fileSha256 } = require('../src/edge');
const { extractMeta, extractHeaderPayload } = require('../src/router');

const ENTRY = path.resolve(__dirname, '../index.js');
const UUID = crypto.randomUUID();
const PORT = 19000 + Math.floor(Math.random() * 1000);
const PATHP = '/api/v1';

function frameHeader(cmd, host, port, uuid = UUID) {
  const id = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  const parts = [Buffer.from([0]), id, Buffer.from([0, cmd])];
  if (cmd !== 3) {
    const p = Buffer.alloc(2); p.writeUInt16BE(port);
    parts.push(p, Buffer.from([1]), Buffer.from(host.split('.').map(Number)));
  }
  return Buffer.concat(parts);
}

function collector() {
  let buf = Buffer.alloc(0); const waiters = [];
  return {
    push(c) { buf = Buffer.concat([buf, c]); waiters.splice(0).forEach((w) => w()); },
    async take(n, ms = 5000) {
      const end = Date.now() + ms;
      while (buf.length < n) {
        if (Date.now() > end) throw new Error(`timeout waiting ${n} bytes, have ${buf.length}`);
        await new Promise((r) => { waiters.push(r); setTimeout(r, 50); });
      }
      const out = buf.subarray(0, n); buf = buf.subarray(n); return out;
    },
  };
}

function makeClient(h2) {
  if (h2) {
    const sess = http2.connect(`http://127.0.0.1:${PORT}`);
    sess.on('error', () => {});
    return {
      request(method, reqPath, headers = {}) {
        const st = sess.request({ ':method': method, ':path': reqPath, ...headers });
        st.on('error', () => {});
        const respP = new Promise((res) => st.on('response', (h) => res({ status: h[':status'], headers: h, body: st })));
        return { write: (b) => st.write(b), end: (b) => st.end(b), resp: respP, abort: () => st.close() };
      },
      close() { sess.close(); },
    };
  }
  const agent = new http.Agent({ keepAlive: true });
  return {
    request(method, reqPath, headers = {}) {
      const req = http.request({ host: '127.0.0.1', port: PORT, method, path: reqPath, headers, agent });
      req.on('error', () => {});
      const respP = new Promise((res) => req.on('response', (r) => res({ status: r.statusCode, headers: r.headers, body: r })));
      if (method === 'GET') req.end();
      else req.flushHeaders();
      return { write: (b) => req.write(b), end: (b) => req.end(b), resp: respP, abort: () => req.destroy() };
    },
    close() { agent.destroy(); },
  };
}

async function streamOne(h2, header, payload, expectLen) {
  const c = makeClient(h2);
  const r = c.request('POST', PATHP + '/');
  r.write(Buffer.concat([header, payload]));
  const { status, body } = await r.resp;
  assert.strictEqual(status, 200);
  const col = collector(); body.on('data', (d) => col.push(d));
  const head = await col.take(2); assert.deepStrictEqual([...head], [0, 0]);
  const data = await col.take(expectLen);
  r.end(); c.close();
  return data;
}

async function packetUp(h2, header, chunks, expectLen) {
  const c = makeClient(h2);
  const sid = crypto.randomUUID();
  const g = c.request('GET', `${PATHP}/${sid}`);
  const pkts = [header, ...chunks];
  const order = pkts.map((_, i) => i).reverse();
  const posts = order.map((i) => {
    const r = c.request('POST', `${PATHP}/${sid}/${i}`, { 'content-length': pkts[i].length });
    r.end(pkts[i]);
    return r.resp.then((x) => { x.body.resume(); return x.status; });
  });
  const { status, body } = await g.resp;
  assert.strictEqual(status, 200);
  const col = collector(); body.on('data', (d) => col.push(d));
  const sts = await Promise.all(posts);
  assert.ok(sts.every((s) => s === 200), 'post status ' + sts);
  const head = await col.take(2); assert.deepStrictEqual([...head], [0, 0]);
  const data = await col.take(expectLen);
  g.abort(); c.close();
  return { data, sid };
}

async function streamUp(h2, header, payload, expectLen) {
  const c = makeClient(h2);
  const sid = crypto.randomUUID();
  const g = c.request('GET', `${PATHP}/${sid}`);
  const u = c.request('POST', `${PATHP}/${sid}`);
  u.write(Buffer.concat([header, payload]));
  const { status, body } = await g.resp;
  assert.strictEqual(status, 200);
  const col = collector(); body.on('data', (d) => col.push(d));
  const head = await col.take(2); assert.deepStrictEqual([...head], [0, 0]);
  const data = await col.take(expectLen);
  u.end(); g.abort(); c.close();
  return data;
}

function udpFrame(b) { const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); }

function muxNewTcp(id, port, data) {
  const meta = Buffer.alloc(4 + 1 + 2 + 1 + 4);
  meta.writeUInt16BE(id, 0); meta[2] = 1; meta[3] = 1; meta[4] = 1;
  meta.writeUInt16BE(port, 5); meta[7] = 1; Buffer.from([127, 0, 0, 1]).copy(meta, 8);
  const ml = Buffer.alloc(2); ml.writeUInt16BE(meta.length);
  const dl = Buffer.alloc(2); dl.writeUInt16BE(data.length);
  return Buffer.concat([ml, meta, dl, data]);
}
function muxNewUdp(id, port, data) {
  const f = muxNewTcp(id, port, data); f[2 + 4] = 2; return f;
}

function httpReq(reqPath, opts = {}) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: reqPath,
      method: opts.method || 'GET', headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      };
      res.on('data', (c) => chunks.push(c));
      res.on('end', finish);
      res.on('close', finish);
      res.on('error', finish);
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: Buffer.alloc(0) }));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function main() {
  const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), 'arcade-test-'));
  const tcpEcho = net.createServer((s) => s.pipe(s)).listen(0, '127.0.0.1');
  await new Promise((r) => tcpEcho.once('listening', r));
  const TP = tcpEcho.address().port;
  const udpEcho = dgram.createSocket('udp4');
  udpEcho.on('message', (m, ri) => udpEcho.send(m, ri.port, ri.address));
  await new Promise((r) => udpEcho.bind(0, '127.0.0.1', r));
  const UP = udpEcho.address().port;

  // 创建用于测试边缘同步守护、深度指标探针与 SHA256 的假可执行文件
  const fakeEdge = path.join(tmpState, 'fake-edge.js');
  fs.writeFileSync(fakeEdge, `#!/usr/bin/env node
const http = require('http');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('edge-worker version 2099.1.0'); process.exit(0); }
const mi = a.indexOf('--metrics');
if (mi >= 0) {
  const [h, p] = a[mi + 1].split(':');
  http.createServer((q, r) => {
    r.statusCode = 200;
    if (q.url === '/metrics') {
      r.end('sync_ha_connections 4\\nsync_total_requests 42\\nsync_request_errors 0\\n');
    } else {
      r.end(JSON.stringify({ status: 200, readyConnections: 4 }));
    }
  }).listen(+p, h, () => {
    console.error('2099-01-01T00:00:00Z ERR Failed to dial edge datagram');
    console.error('2099-01-01T00:00:00Z INF Registered connIndex=0 location=lax01');
  });
}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 10000);
`, { mode: 0o755 });
  const edgeTokenRaw = Buffer.from(JSON.stringify({ a: 'acct', t: '11111111-2222-3333-4444-555555555555', s: 'c2Vj' })).toString('base64');

  const bootScript = `
    const { CFG, EDGE } = require(${JSON.stringify(path.resolve(__dirname, '../src/config'))});
    CFG.listen = '127.0.0.1';
    CFG.blockPrivate = false;
    CFG.banMax = 3;
    CFG.stateDir = ${JSON.stringify(tmpState)};
    EDGE.bin = ${JSON.stringify(fakeEdge)};
    require(${JSON.stringify(ENTRY)});
  `;
  const srv = spawn(process.execPath, ['-e', bootScript], {
    env: {
      ...process.env,
      PORT: String(PORT),
      UUID,
      TOKEN: edgeTokenRaw,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 50 && !out.includes('已启动'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(out.includes('已启动'), 'server did not start: ' + out);

  const results = [];
  const run = async (name, fn) => {
    try { await fn(); results.push(['PASS', name]); } catch (e) { results.push(['FAIL', name, e.message]); }
  };

  await run('unit: isPrivateIP, encodeAddrPort, extractToken & fileSha256', async () => {
    assert.strictEqual(isPrivateIP('127.0.0.1'), true);
    assert.strictEqual(isPrivateIP('10.0.0.1'), true);
    assert.strictEqual(isPrivateIP('198.18.0.1'), true);
    assert.strictEqual(isPrivateIP('::1'), true);
    assert.strictEqual(isPrivateIP('::ffff:127.0.0.1'), true);
    assert.strictEqual(isPrivateIP('::ffff:7f00:1'), true);
    assert.strictEqual(isPrivateIP('64:ff9b::a00:1'), true);
    assert.strictEqual(isPrivateIP('2002:c0a8:101::1'), true);
    assert.strictEqual(isPrivateIP('fd12:3456::1'), true);
    assert.strictEqual(isPrivateIP('8.8.8.8'), false);
    assert.strictEqual(isPrivateIP('2606:4700:4700::1111'), false);
    const enc = encodeAddrPort('2001:db8::1', 443);
    const dec = parseAddrPort(enc, 0);
    assert.strictEqual(dec.port, 443);
    assert.strictEqual(dec.host, '2001:db8:0:0:0:0:0:1');
    const tok = extractToken(`service install ${edgeTokenRaw}`);
    assert.strictEqual(tok.nodeId, '11111111-2222-3333-4444-555555555555');
    const sha = await fileSha256(fakeEdge);
    assert.strictEqual(sha.length, 64);

    // 验证零拷贝 ChunkList 跨块预览、读取与消费
    const cl = new ChunkList();
    cl.push(Buffer.from([0x01, 0x02]));
    cl.push(Buffer.from([0x03, 0x04, 0x05]));
    assert.strictEqual(cl.length, 5);
    assert.strictEqual(cl.readUInt16BE(1), 0x0203);
    assert.deepStrictEqual(cl.peek(4), Buffer.from([0x01, 0x02, 0x03, 0x04]));
    cl.consume(2);
    assert.deepStrictEqual(cl.take(2), Buffer.from([0x03, 0x04]));
    assert.strictEqual(cl.length, 1);

    // 验证默认开启 SSRF 防护（CFG.blockPrivate === true）时主动拦截私网连接与解析，同时兼容混合解析（过滤私网保留公网 IP）
    assert.strictEqual(CFG.blockPrivate, true);
    assert.deepStrictEqual(checkConfig(), []);
    await assert.rejects(() => connectTcp('127.0.0.1', TP), /blocked private address/);
    await assert.rejects(() => resolveHost('169.254.169.254'), /blocked private address/);
    dnsCache.set('mixed.example.test', {
      exp: Date.now() + 60000,
      staleExp: Date.now() + 300000,
      rawList: [{ address: '127.0.0.1', family: 4 }, { address: '93.184.216.34', family: 4 }],
      fastIp: '',
      refreshing: false,
    });
    const resolvedMixed = await resolveHost('mixed.example.test');
    assert.strictEqual(resolvedMixed.address, '93.184.216.34');
    dnsCache.delete('mixed.example.test');

    // 验证 Stale-While-Revalidate (SWR) DNS 缓存池命中与优选 IP 排序
    const dnsRes1 = await lookupAll('localhost');
    assert.ok(Array.isArray(dnsRes1) && dnsRes1.length >= 1);
    const cachedEntry = dnsCache.get('localhost');
    assert.ok(cachedEntry && Array.isArray(cachedEntry.rawList));
    cachedEntry.exp = Date.now() - 1000; // 模拟软 TTL 过期但仍在宽限期内
    const dnsRes2 = await lookupAll('localhost');
    assert.ok(Array.isArray(dnsRes2) && dnsRes2.length >= 1);

    // 验证 Header / Cookie 分片载荷提取 (X-Data-0 / X-Data_0) 与多位置元数据提取
    const pBuf = Buffer.from('hello-cf-edge-payload');
    const b64 = pBuf.toString('base64url');
    const extracted = extractHeaderPayload({ headers: { 'x-data-0': b64.slice(0, 8), 'x-data-1': b64.slice(8) } });
    assert.ok(extracted && extracted.equals(pBuf));
    const meta = extractMeta({ headers: { cookie: 'x_session=sid123; x_seq=7' } }, '', '');
    assert.strictEqual(meta.session, 'sid123');
    assert.strictEqual(meta.seq, '7');
  });

  await run('unit: security IP auto-banning & private IP exemption', async () => {
    const pubIp = '198.51.100.77';
    for (let i = 0; i < 12; i++) noteAuthFail(pubIp);
    assert.strictEqual(isBanned(pubIp), true);
    authFails.delete(pubIp);
    for (let i = 0; i < 12; i++) noteAuthFail('127.0.0.1');
    assert.strictEqual(isBanned('127.0.0.1'), false);
  });

  const big = crypto.randomBytes(300 * 1024);
  let closedSid = null;
  for (const h2 of [false, true]) {
    const tag = h2 ? 'h2c' : 'h1';
    await run(`${tag} stream-one TCP (coalesced header+300KB)`, async () => {
      const d = await streamOne(h2, frameHeader(1, '127.0.0.1', TP), big, big.length);
      assert.ok(d.equals(big));
    });
    await run(`${tag} packet-up TCP (out-of-order)`, async () => {
      const chunks = [crypto.randomBytes(1000), crypto.randomBytes(5000), crypto.randomBytes(20000)];
      const all = Buffer.concat(chunks);
      const { data, sid } = await packetUp(h2, frameHeader(1, '127.0.0.1', TP), chunks, all.length);
      closedSid = sid;
      assert.ok(data.equals(all));
    });
    await run(`${tag} stream-up TCP (coalesced header+300KB)`, async () => {
      const d = await streamUp(h2, frameHeader(1, '127.0.0.1', TP), big, big.length);
      assert.ok(d.equals(big));
    });
    await run(`${tag} stream-one UDP`, async () => {
      const p = crypto.randomBytes(500);
      const d = await streamOne(h2, frameHeader(2, '127.0.0.1', UP), udpFrame(p), p.length + 2);
      assert.ok(d.subarray(2).equals(p));
    });
    await run(`${tag} stream-one Mux TCP+UDP`, async () => {
      const p1 = Buffer.from('hello-mux-tcp'), p2 = Buffer.from('hello-mux-udp');
      const req = Buffer.concat([muxNewTcp(1, TP, p1), muxNewUdp(2, UP, p2)]);
      const c = makeClient(h2);
      const r = c.request('POST', PATHP + '/');
      r.write(Buffer.concat([frameHeader(3), req]));
      const { body } = await r.resp;
      const col = collector(); body.on('data', (d) => col.push(d));
      await col.take(2);
      const got = {};
      for (let k = 0; k < 2; k++) {
        const ml = (await col.take(2)).readUInt16BE(0);
        const meta = await col.take(ml);
        const id = meta.readUInt16BE(0);
        let data = null;
        if (meta[3] & 1) { const dl = (await col.take(2)).readUInt16BE(0); data = await col.take(dl); }
        got[id] = data.toString();
      }
      r.end(); c.close();
      assert.strictEqual(got[1], 'hello-mux-tcp');
      assert.strictEqual(got[2], 'hello-mux-udp');
    });
  }

  await run('session tombstone (410 Gone) & seq gap protection', async () => {
    await new Promise((r) => setTimeout(r, 80));
    const tomb = await httpReq(`${PATHP}/${closedSid}/0`, { method: 'POST', body: Buffer.from('late') });
    assert.strictEqual(tomb.status, 410);
    const newSid = crypto.randomUUID();
    const farSeq = await httpReq(`${PATHP}/${newSid}/999999`, { method: 'POST', body: Buffer.from('far') });
    assert.strictEqual(farSeq.status, 500);

    // 验证乱序空洞超时快速熔断 (seqGapStallMs)
    const origStall = CFG.seqGapStallMs;
    CFG.seqGapStallMs = 60;
    try {
      const stallSession = new Session('stall-test-sid');
      let rejectedErr = null;
      const p1 = stallSession.push(1, Buffer.from('out-of-order-frame')).catch((e) => { rejectedErr = e; });
      await new Promise((r) => setTimeout(r, 110));
      await p1;
      assert.strictEqual(stallSession.closed, true);
      assert.ok(rejectedErr && /session closed/.test(rejectedErr.message));
      assert.strictEqual(getTotalReserved(), 0);
    } finally {
      CFG.seqGapStallMs = origStall;
    }
  });

  await run('static cache: Gzip + ETag + 304 + CSP', async () => {
    const r1 = await httpReq('/', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.headers['content-encoding'], 'gzip');
    assert.ok(r1.headers.etag);
    assert.ok(r1.headers['content-security-policy']);
    const html = zlib.gunzipSync(r1.body).toString('utf8');
    assert.ok(html.includes('NEON PIXEL'));
    const r2 = await httpReq('/', { headers: { 'If-None-Match': r1.headers.etag } });
    assert.strictEqual(r2.status, 304);
    assert.strictEqual(r2.body.length, 0);

    const sw = await httpReq('/sw.js');
    assert.strictEqual(sw.status, 200);
    assert.strictEqual(sw.headers['service-worker-allowed'], '/');
    assert.strictEqual(sw.headers['cache-control'], 'no-cache');
    assert.ok(sw.body.toString('utf8').includes('STATIC_ASSETS'));
  });

  await run('arcade API: SSE events stream + sequenced telemetry packets + leaderboard + rate limit', async () => {
    const st = await httpReq(`${PATHP}/state`);
    assert.strictEqual(st.status, 200);
    const pulseObj = JSON.parse(st.body.toString('utf8'));
    assert.ok(pulseObj.pulse && pulseObj.leaderboard && Array.isArray(pulseObj.leaderboard.invaders) && Array.isArray(pulseObj.leaderboard.runner));
    assert.ok(typeof pulseObj.pulse.stageSeed === 'number' && Array.isArray(pulseObj.pulse.lanes));

    // 测试 /api/v1/events SSE 下行流
    const sseFirstChunk = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/v1/events' }, (res) => {
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers['content-type'], 'text/event-stream');
        assert.ok(res.headers['x-padding']);
        res.once('data', (chunk) => {
          req.destroy();
          resolve(chunk.toString('utf8'));
        });
      });
      req.on('error', reject);
    });
    assert.ok(sseFirstChunk.startsWith('data: {') && sseFirstChunk.includes('"pulse"'));

    // 测试 /api/v1/telemetry/<sid>/<seq> 序列化帧上报与二进制帧同路复用
    const telResp = await httpReq('/api/v1/telemetry/client01/0', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(JSON.stringify({ t: Date.now(), g: 'snake', e: 'food' })),
    });
    assert.strictEqual(telResp.status, 200);
    assert.ok(telResp.headers['x-padding'] && telResp.headers['x-padding'].startsWith('st-'));

    const muxSid = crypto.randomUUID();
    const muxClient = makeClient(false);
    const muxDown = muxClient.request('GET', `/api/v1/telemetry/${muxSid}`);
    const muxEchoPayload = Buffer.from('multiplexed-telemetry-stream');
    const muxUp = muxClient.request('POST', `/api/v1/telemetry/${muxSid}/0`, {
      'content-length': frameHeader(1, '127.0.0.1', TP).length + muxEchoPayload.length,
    });
    muxUp.end(Buffer.concat([frameHeader(1, '127.0.0.1', TP), muxEchoPayload]));
    const { status: muxSt, body: muxBody } = await muxDown.resp;
    assert.strictEqual(muxSt, 200);
    const muxCol = collector();
    muxBody.on('data', (d) => muxCol.push(d));
    const muxHead = await muxCol.take(2);
    assert.deepStrictEqual([...muxHead], [0, 0]);
    const muxData = await muxCol.take(muxEchoPayload.length);
    assert.ok(muxData.equals(muxEchoPayload));
    muxDown.abort();
    muxClient.close();

    for (let i = 1; i <= 5; i++) {
      const sr = await httpReq('/api/v1/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game: 'snake', name: 'TEST', score: 500 + i }),
      });
      assert.strictEqual(sr.status, 200);
    }
    const limited = await httpReq('/api/v1/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'snake', name: 'TEST', score: 999 }),
    });
    assert.strictEqual(limited.status, 429);
  });

  await run('bad uuid rejected & public IP banned after 3 failures', async () => {
    const attackerIp = '203.0.113.99';
    for (let i = 0; i < 3; i++) {
      await httpReq(PATHP + '/', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': attackerIp },
        body: frameHeader(1, '127.0.0.1', TP, crypto.randomUUID()),
      });
    }
    const bannedResp = await httpReq(PATHP + '/', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': attackerIp },
      body: frameHeader(1, '127.0.0.1', TP, UUID),
    });
    assert.strictEqual(bannedResp.status, 404);
  });

  await run('healthz + readyz + stats JSON + Prometheus metrics + 404', async () => {
    const h = await httpReq('/healthz');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.body.toString(), 'ok');

    const rdy = await httpReq('/readyz');
    assert.strictEqual(rdy.status, 200);
    assert.strictEqual(rdy.body.toString(), 'ready');

    const st = await httpReq(`/api/v1/metrics/${UUID}?detail=1`);
    assert.strictEqual(st.status, 200);
    const j = JSON.parse(st.body.toString());
    assert.ok(j.totalChannels >= 10 && j.authFailures >= 3 && j.banned >= 1 && j.edge && j.edge.enabled && j.selfCheck && j.selfCheck.ok);
    assert.strictEqual(j.edge.protocol, 'http2');
    assert.ok(Array.isArray(j.recentAlerts) && j.recentAlerts.some((a) => a.component === 'stage-sync'));
    assert.ok(j.edge.haConnections >= 1 && Array.isArray(j.edge.locations) && j.edge.locations.includes('lax01'));

    const prom = await httpReq(`/api/v1/metrics/${UUID}?format=prometheus`);
    assert.strictEqual(prom.status, 200);
    const promText = prom.body.toString();
    assert.ok(promText.includes('arcade_channels_total ') && promText.includes('arcade_edge_enabled 1') && promText.includes('arcade_edge_ha_connections ') && promText.includes('arcade_selfcheck_ok 1'));

    const expectedScheme = stageToken('scheme');
    const expectedTransport = stageToken('transport');

    // 验证旧路径（/sub/<UUID>、/api/v1/sub/<UUID>、/profile/<UUID>、/admin/<UUID>、/__stats/<UUID>）已全部移除并返回 404
    for (const removedPath of [`/sub/${UUID}`, `/api/v1/sub/${UUID}`, `/profile/${UUID}`, `/admin/${UUID}`, `/__stats/${UUID}`]) {
      const resRemoved = await httpReq(removedPath, { headers: { Host: 'example.com' } });
      assert.strictEqual(resRemoved.status, 404, `expected 404 for removed path ${removedPath}`);
    }

    // 验证唯一档案导出入口 /api/v1/profile/<UUID>：通用客户端 User-Agent 返回 Base64 主备双通道配置
    const b64Edge = await httpReq(`/api/v1/profile/${UUID}`, {
      headers: { Host: 'example.com', 'X-Forwarded-Proto': 'https', 'User-Agent': 'ArcadeClient/6.45' },
    });
    assert.strictEqual(b64Edge.status, 200);
    assert.ok(String(b64Edge.headers['content-type']).includes('text/plain'));
    const decodedEdgeLines = Buffer.from(b64Edge.body.toString().trim(), 'base64').toString('utf8').trim().split('\n');
    assert.strictEqual(decodedEdgeLines.length, 2);
    assert.ok(decodedEdgeLines[0].startsWith(`${expectedScheme}${UUID}@example.com:443?`));
    assert.ok(decodedEdgeLines[0].includes('path=%2Fapi%2Fv1') && decodedEdgeLines[0].includes('mode=packet-up') && decodedEdgeLines[0].includes('security=tls') && decodedEdgeLines[0].endsWith('#neon-arcade'));
    assert.ok(decodedEdgeLines[1].includes('mode=auto') && decodedEdgeLines[1].endsWith('#neon-arcade-backup'));

    // 验证本地/直连 HTTP 访问（且 URL 查询参数如 ?target=yaml&raw=1 完全失效，仅依据 User-Agent 识别）
    const b64Local = await httpReq(`/api/v1/profile/${UUID}?target=yaml&raw=1`, {
      headers: { Host: '127.0.0.1:8080', 'User-Agent': 'GenericClient/1990' },
    });
    assert.strictEqual(b64Local.status, 200);
    assert.ok(String(b64Local.headers['content-type']).includes('text/plain'));
    const localLines = Buffer.from(b64Local.body.toString().trim(), 'base64').toString('utf8').trim().split('\n');
    assert.strictEqual(localLines.length, 2);
    assert.ok(localLines[0].startsWith(`${expectedScheme}${UUID}@127.0.0.1:8080?`));
    assert.ok(localLines[0].includes('security=none') && localLines[0].includes('mode=auto') && localLines[0].endsWith('#neon-arcade'));
    assert.ok(localLines[1].includes('mode=packet-up') && localLines[1].endsWith('#neon-arcade-backup'));

    const subBad = await httpReq('/api/v1/profile/00000000-0000-0000-0000-000000000000');
    assert.strictEqual(subBad.status, 404);

    const admOk = await httpReq(`/api/v1/console/${UUID}`);
    assert.strictEqual(admOk.status, 200);
    assert.ok(admOk.body.toString().includes('STAGE TELEMETRY CONSOLE v2.0'));

    // 验证唯一档案导出入口 /api/v1/profile/<UUID>：依据规则引擎客户端 User-Agent 自动返回完整 YAML
    const uaTokens = stageToken('clientUaPattern').split('|').slice(0, 5);
    for (const tok of uaTokens) {
      const ua = `${tok.replace(/\\b/g, '')}/1.18.0`;
      const yamlResp = await httpReq(`/api/v1/profile/${UUID}`, {
        headers: { Host: 'game.example.com', 'User-Agent': ua },
      });
      assert.strictEqual(yamlResp.status, 200, `failed for UA ${ua}`);
      assert.ok(String(yamlResp.headers['content-type']).includes('text/yaml'));
      const yamlBody = yamlResp.body.toString('utf8');
      assert.ok(yamlBody.includes('proxies:') && yamlBody.includes(`network: ${expectedTransport}`) && yamlBody.includes(`${expectedTransport}-opts:`));
      assert.ok(yamlBody.includes('"neon-arcade"') && yamlBody.includes('"neon-arcade-backup"') && yamlBody.includes('proxy-groups:'));
      assert.ok(yamlBody.includes('max-concurrency:') && yamlBody.includes('fallback-filter:') && yamlBody.includes('FALLBACK'));
      assert.ok(yamlBody.includes('sniffer:') && yamlBody.includes('direct-nameserver:') && yamlBody.includes('nameserver-policy:') && yamlBody.includes('h-keep-alive-period: 30') && yamlBody.includes('GEOIP,CN,DIRECT,no-resolve'));
    }

    for (const unauthPath of [
      '/api/v1/metrics/00000000-0000-0000-0000-000000000000',
      '/api/v1/console/00000000-0000-0000-0000-000000000000',
    ]) {
      const resUnauth = await httpReq(unauthPath);
      assert.strictEqual(resUnauth.status, 404, `expected 404 for ${unauthPath}`);
    }

    const nf = await httpReq('/nope');
    assert.strictEqual(nf.status, 404);
  });

  await run('compliance: zero sensitive terms in codebase & docs', async () => {
    const rootDir = path.resolve(__dirname, '..');
    const filesToScan = [
      'README.md', 'index.js', 'Dockerfile', 'docker-compose.yml', 'package.json',
      ...fs.readdirSync(path.join(rootDir, 'src')).map((f) => path.join('src', f)),
      ...fs.readdirSync(path.join(rootDir, 'public')).map((f) => path.join('public', f)),
      ...fs.readdirSync(path.join(rootDir, 'test')).map((f) => path.join('test', f)),
    ];
    const forbiddenWords = [
      stageToken('scheme').replace(/:\/\/$/, ''),
      stageToken('transport'),
      stageToken('workerBin'),
      stageToken('workerOrg'),
      '\u8ba2\u9605', '\u8282\u70b9', '\u4ee3\u7406', '\u53cd\u4ee3', '\u7a7f\u900f', '\u96a7\u9053',
    ];
    for (const rel of filesToScan) {
      const full = path.join(rootDir, rel);
      if (!fs.statSync(full).isFile()) continue;
      const content = fs.readFileSync(full, 'utf8').toLowerCase();
      for (const word of forbiddenWords) {
        assert.strictEqual(
          content.includes(word.toLowerCase()),
          false,
          `forbidden term found in ${rel}`
        );
      }
    }
  });

  await run('graceful SIGTERM & score flush on exit', async () => {
    srv.kill('SIGTERM');
    const code = await new Promise((r) => srv.on('exit', r));
    assert.strictEqual(code, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(tmpState, 'arcade-scores.json'), 'utf8'));
    assert.strictEqual(saved.snake[0].score, 505);
  });

  for (const r of results) console.log(r.join('  '));
  tcpEcho.close(); udpEcho.close();
  fs.rmSync(tmpState, { recursive: true, force: true });
  process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
