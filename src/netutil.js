'use strict';
// 网络与零拷贝缓冲工具：ChunkList 零拷贝队列、内网地址过滤、通用帧地址编解码、DNS 缓存、Happy Eyeballs 双栈并发连接

const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
const { CFG } = require('./config');
const { log } = require('./log');

// ───────────────────────────── 零拷贝分块缓冲区 (ChunkList) ─────────────────────────────
class ChunkList {
  constructor() {
    this.chunks = [];
    this.headOff = 0;
    this.length = 0;
  }

  push(buf) {
    if (!buf || !buf.length) return;
    this.chunks.push(buf);
    this.length += buf.length;
  }

  clear() {
    this.chunks.length = 0;
    this.headOff = 0;
    this.length = 0;
  }

  readUInt8(off = 0) {
    let idx = off + this.headOff;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (idx < c.length) return c[idx];
      idx -= c.length;
    }
    return 0;
  }

  readUInt16BE(off = 0) {
    if (this.chunks.length > 0 && this.headOff + off + 2 <= this.chunks[0].length) {
      return this.chunks[0].readUInt16BE(this.headOff + off);
    }
    return (this.readUInt8(off) << 8) | this.readUInt8(off + 1);
  }

  // 零拷贝或最小化拷贝预览前 n 个字节（不消费）
  peek(n) {
    if (n <= 0 || this.length === 0) return Buffer.alloc(0);
    const len = Math.min(n, this.length);
    const first = this.chunks[0];
    if (first.length - this.headOff >= len) {
      return first.subarray(this.headOff, this.headOff + len);
    }
    const out = Buffer.allocUnsafe(len);
    let copied = 0;
    let cIdx = 0;
    let cOff = this.headOff;
    while (copied < len && cIdx < this.chunks.length) {
      const c = this.chunks[cIdx];
      const avail = c.length - cOff;
      const take = Math.min(avail, len - copied);
      c.copy(out, copied, cOff, cOff + take);
      copied += take;
      cIdx++;
      cOff = 0;
    }
    return out;
  }

  // 消费前 n 个字节
  consume(n) {
    if (n <= 0) return;
    if (n >= this.length) {
      this.clear();
      return;
    }
    this.length -= n;
    let rem = n;
    while (rem > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      const avail = first.length - this.headOff;
      if (rem < avail) {
        this.headOff += rem;
        return;
      }
      rem -= avail;
      this.chunks.shift();
      this.headOff = 0;
    }
  }

  // 取出并消费前 n 个字节
  take(n) {
    const out = this.peek(n);
    this.consume(out.length);
    return out;
  }

  // 取出全部剩余数据并清空
  drainAll() {
    if (this.length === 0) return Buffer.alloc(0);
    return this.take(this.length);
  }
}

function isPrivateIPv4Parts(a, b, c, d) {
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 255 && b === 255 && c === 255 && d === 255);
}

function expandIPv6Groups(host) {
  const zone = host.indexOf('%');
  const clean = (zone >= 0 ? host.slice(0, zone) : host).toLowerCase();
  const halves = clean.split('::');
  if (halves.length > 2) return null;
  const parseSide = (str) => {
    if (!str) return [];
    const parts = str.split(':');
    const out = [];
    for (const p of parts) {
      if (p.includes('.')) {
        const v4 = p.split('.').map(Number);
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        const v = parseInt(p, 16);
        if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
        out.push(v);
      }
    }
    return out;
  };
  const left = parseSide(halves[0]);
  const right = halves.length === 2 ? parseSide(halves[1]) : [];
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return null;
  return [...left, ...new Array(Math.max(0, missing)).fill(0), ...right];
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c, d] = ip.split('.').map(Number);
    return isPrivateIPv4Parts(a, b, c, d);
  }
  if (net.isIPv6(ip)) {
    const g = expandIPv6Groups(ip);
    if (!g) return true;
    if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      return isPrivateIPv4Parts(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
    }
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPrivateIPv4Parts(g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff);
    }
    if (g[0] === 0x2002) {
      return isPrivateIPv4Parts(g[1] >> 8, g[1] & 0xff, g[2] >> 8, g[2] & 0xff);
    }
    if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00) return true;
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
    return false;
  }
  return false;
}

// 解析通用帧地址：port(2) + type(1) + addr。数据不足返回 null
function parseAddrPort(buf, off) {
  if (buf.length < off + 4) return null;
  const port = buf.readUInt16BE(off);
  const type = buf[off + 2];
  let p = off + 3;
  let host;
  if (type === 1) {
    if (buf.length < p + 4) return null;
    host = `${buf[p]}.${buf[p + 1]}.${buf[p + 2]}.${buf[p + 3]}`;
    p += 4;
  } else if (type === 2) {
    if (buf.length < p + 1) return null;
    const len = buf[p];
    if (len === 0) return { error: 'empty domain' };
    if (buf.length < p + 1 + len) return null;
    host = buf.toString('utf8', p + 1, p + 1 + len);
    p += 1 + len;
  } else if (type === 3) {
    if (buf.length < p + 16) return null;
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(buf.readUInt16BE(p + i * 2).toString(16));
    host = parts.join(':');
    p += 16;
  } else {
    return { error: 'unknown address type ' + type };
  }
  return { host, port, next: p };
}

function encodeAddrPort(host, port) {
  const head = Buffer.allocUnsafe(2);
  head.writeUInt16BE(port);
  if (net.isIPv4(host)) {
    const parts = host.split('.');
    return Buffer.from([head[0], head[1], 1, +parts[0], +parts[1], +parts[2], +parts[3]]);
  }
  if (net.isIPv6(host)) {
    const g = expandIPv6Groups(host);
    if (g) {
      const b = Buffer.allocUnsafe(19);
      b[0] = head[0]; b[1] = head[1]; b[2] = 3;
      for (let i = 0; i < 8; i++) b.writeUInt16BE(g[i], 3 + i * 2);
      return b;
    }
  }
  const name = Buffer.from(host);
  return Buffer.concat([head, Buffer.from([2, name.length]), name]);
}

function waitDrain(sock) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sock.off('drain', onDrain);
      sock.off('close', onClose);
      sock.off('error', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('socket closed')); };
    sock.once('drain', onDrain);
    sock.once('close', onClose);
    sock.once('error', onClose);
  });
}

// 带 Stale-While-Revalidate (SWR) 与 LRU 的双栈 DNS 缓存池：
// 软 TTL 60 秒（0ms 命中），宽限期 300 秒（立即返回旧记录并后台静默刷新），失败负缓存 3 秒，并发同名查询自动合并
const dnsCache = new Map();
const DNS_SOFT_TTL_MS = 60000;
const DNS_STALE_TTL_MS = 300000;
const DNS_NEG_TTL_MS = 3000;
const DNS_MAX_ENTRIES = 2048;

function interleaveAddresses(list, preferredIp) {
  const v4 = [];
  const v6 = [];
  let pref = null;
  for (const item of list) {
    if (preferredIp && item.address === preferredIp && !pref) {
      pref = item;
    } else if (item.family === 4) {
      v4.push(item);
    } else {
      v6.push(item);
    }
  }
  const out = [];
  if (pref) out.push(pref);
  // IPv4 优先排列，IPv6 作为回退（避免双栈环境因云厂商 IPv6 归属地漂移导致目标站点地区误判，同时兼容纯 IPv6 目标）
  return out.concat(v4, v6);
}

function fetchDnsList(host, entry) {
  entry.refreshing = true;
  const p = dns.promises.lookup(host, { all: true }).then((list) => {
    if (!Array.isArray(list) || list.length === 0) throw new Error('dns empty result for ' + host);
    const now = Date.now();
    entry.rawList = list;
    entry.exp = now + DNS_SOFT_TTL_MS;
    entry.staleExp = now + DNS_STALE_TTL_MS;
    entry.refreshing = false;
    return interleaveAddresses(list, entry.fastIp);
  }).catch((err) => {
    entry.refreshing = false;
    if (!entry.rawList) {
      entry.exp = Date.now() + DNS_NEG_TTL_MS;
      entry.staleExp = entry.exp;
    }
    throw err;
  });
  entry.p = p;
  return p;
}

function lookupAll(host) {
  const now = Date.now();
  const c = dnsCache.get(host);
  if (c) {
    // 刷新 LRU 顺序
    dnsCache.delete(host);
    dnsCache.set(host, c);
    if (c.exp > now) {
      if (c.rawList) return Promise.resolve(interleaveAddresses(c.rawList, c.fastIp));
      return c.p;
    }
    if (c.staleExp > now && c.rawList) {
      if (!c.refreshing) fetchDnsList(host, c).catch(() => {});
      return Promise.resolve(interleaveAddresses(c.rawList, c.fastIp));
    }
  }
  const prevFastIp = c && c.fastIp ? c.fastIp : '';
  const entry = {
    exp: now + DNS_SOFT_TTL_MS,
    staleExp: now + DNS_STALE_TTL_MS,
    p: null,
    rawList: null,
    fastIp: prevFastIp,
    refreshing: false,
  };
  if (dnsCache.size >= DNS_MAX_ENTRIES) dnsCache.delete(dnsCache.keys().next().value);
  dnsCache.set(host, entry);
  return fetchDnsList(host, entry);
}

async function resolveHost(host) {
  if (net.isIP(host)) {
    if (CFG.blockPrivate && isPrivateIP(host)) throw new Error('blocked private address ' + host);
    return { address: host, family: net.isIP(host) };
  }
  const rawList = await lookupAll(host);
  const list = CFG.blockPrivate ? rawList.filter((a) => !isPrivateIP(a.address)) : rawList;
  if (list.length === 0) {
    if (rawList.length > 0) throw new Error('blocked private address ' + rawList[0].address);
    throw new Error('unable to resolve ' + host);
  }
  const res = list.find((a) => a.family === 4) || list[0];
  if (!res || !res.address) throw new Error('unable to resolve ' + host);
  return res;
}

// Happy Eyeballs (RFC 8305) 双栈快速并发回退连接器：
// 首选 IP 若 250ms 内未完成握手，自动并发尝试备选 IP，首个成功者胜出并缓存为该域名的优选 IP
async function connectTcp(host, port) {
  const check = (ip) => {
    if (CFG.blockPrivate && isPrivateIP(ip)) return new Error('blocked private address ' + ip);
    return null;
  };
  let candidates;
  if (net.isIP(host)) {
    const e = check(host);
    if (e) throw e;
    candidates = [{ address: host, family: net.isIP(host) }];
  } else {
    const rawList = await lookupAll(host);
    const pubList = CFG.blockPrivate ? rawList.filter((a) => !isPrivateIP(a.address)) : rawList;
    if (pubList.length === 0) {
      if (rawList.length > 0) throw new Error('blocked private address ' + rawList[0].address);
      throw new Error('unable to resolve ' + host);
    }
    candidates = pubList.slice(0, 4);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let inFlight = 0;
    let nextIdx = 0;
    let staggerTimer = null;
    let timeoutTimer = null;
    let lastErr = new Error('connect failed');
    const sockets = new Set();

    const cleanupAll = (winner) => {
      if (staggerTimer) { clearTimeout(staggerTimer); staggerTimer = null; }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      for (const s of sockets) {
        if (s !== winner && !s.destroyed) {
          try { s.destroy(); } catch {}
        }
      }
      sockets.clear();
    };

    const tryNext = () => {
      if (settled || nextIdx >= candidates.length) return;
      const cand = candidates[nextIdx++];
      inFlight++;
      const sock = net.connect({ host: cand.address, port, family: cand.family, allowHalfOpen: true });
      sockets.add(sock);

      const onConnect = () => {
        if (settled) { sock.destroy(); return; }
        settled = true;
        sock.removeListener('error', onErr);
        cleanupAll(sock);
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 30000);
        const cacheEntry = dnsCache.get(host);
        if (cacheEntry) cacheEntry.fastIp = cand.address;
        resolve(sock);
      };

      const onErr = (err) => {
        sockets.delete(sock);
        inFlight--;
        lastErr = err || lastErr;
        const cacheEntry = dnsCache.get(host);
        if (cacheEntry && cacheEntry.fastIp === cand.address) cacheEntry.fastIp = '';
        if (settled) return;
        if (nextIdx < candidates.length) {
          if (staggerTimer) { clearTimeout(staggerTimer); staggerTimer = null; }
          tryNext();
        } else if (inFlight === 0) {
          settled = true;
          cleanupAll(null);
          reject(lastErr);
        }
      };

      sock.once('connect', onConnect);
      sock.once('error', onErr);

      if (nextIdx < candidates.length) {
        staggerTimer = setTimeout(tryNext, 250);
        staggerTimer.unref();
      }
    };

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupAll(null);
      reject(new Error('connect timeout'));
    }, CFG.connectTimeoutMs);
    timeoutTimer.unref();

    tryNext();
  });
}

// ───────────────────────────── 数据报房间中继 (DatagramRelay) ─────────────────────────────
class DatagramRelay {
  constructor(onMessage, onError) {
    this.onMessage = onMessage;
    this.onError = onError || null;
    this.socks = {};
    this.closed = false;
    this.lastActive = Date.now();
  }
  _sock(family) {
    let s = this.socks[family];
    if (s) return s;
    s = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
    s.on('message', (msg, rinfo) => {
      if (!this.closed) {
        this.lastActive = Date.now();
        this.onMessage(rinfo.address, rinfo.port, msg);
      }
    });
    s.on('error', (e) => {
      log('debug', 'dgram error', e.message);
      if (!this.closed && this.onError) this.onError(e);
    });
    s.bind(0);
    this.socks[family] = s;
    return s;
  }
  async send(host, port, data) {
    if (this.closed) return;
    this.lastActive = Date.now();
    const { address, family } = await resolveHost(host);
    if (this.closed) return;
    this._sock(family).send(data, port, address, (e) => {
      if (e) {
        log('debug', 'dgram send error', e.message);
        if (!this.closed && this.onError) this.onError(e);
      }
    });
  }
  close() {
    this.closed = true;
    for (const s of Object.values(this.socks)) { try { s.close(); } catch {} }
    this.socks = {};
  }
}

// 定期清理超出宽限期的 DNS 缓存
setInterval(() => {
  const now = Date.now();
  for (const [h, e] of dnsCache) if ((e.staleExp || e.exp) <= now) dnsCache.delete(h);
}, 30000).unref();

const unpackEndpointMeta = parseAddrPort;
const packEndpointMeta = encodeAddrPort;

module.exports = {
  ChunkList,
  DatagramRelay,
  UdpAssoc: DatagramRelay,
  isPrivateIP,
  unpackEndpointMeta,
  packEndpointMeta,
  parseAddrPort,
  encodeAddrPort,
  waitDrain,
  dnsCache,
  lookupAll,
  resolveHost,
  connectTcp,
};
