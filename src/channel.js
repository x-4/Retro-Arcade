'use strict';
// 实时状态通道与零拷贝二进制流引擎：ChunkList 帧头解析、流式通道 / 数据报 / 多路复用房间子通道转发

const crypto = require('crypto');
const { CFG, USERS } = require('./config');
const { log } = require('./log');
const { stats, mixStageSeed } = require('./stats');
const { noteAuthFail } = require('./security');
const { ChunkList, DatagramRelay, unpackEndpointMeta, packEndpointMeta, waitDrain, connectTcp } = require('./netutil');

const STAGE_REV = 0;
const STAGE_ACK = Buffer.from([STAGE_REV, 0]);

function findUser(idBytes) {
  let found = null;
  for (const u of USERS) {
    if (crypto.timingSafeEqual(u.bytes, idBytes)) found = u;
  }
  return found;
}

// ───────────────────────────── 实时状态通道 ─────────────────────────────
const registry = new Set();

class Channel {
  constructor(down, label, ip) {
    this.down = down;
    this.label = label;
    this.ip = ip || '';
    stats.total++;
    this.handshakeTimer = setTimeout(() => { if (this.state === 'init') this._fail('handshake timeout'); }, CFG.handshakeMs);
    this.rx = new ChunkList();
    this.state = 'init'; // init | stream | dgram | arena
    this.dead = false;
    this.headerSent = false;
    this.remote = null;
    this.udp = null;
    this.mux = new Map();
    this.lastActive = Date.now();
    this.createdAt = Date.now();
    this.headerTimer = null;
    this.uplinkGraceTimer = null;
    registry.add(this);
  }

  touch() { this.lastActive = Date.now(); }

  sendDown(chunk) {
    if (this.dead) return false;
    this.touch();
    if (!this.headerSent) {
      this.headerSent = true;
      clearTimeout(this.headerTimer);
      if (chunk && chunk.length) {
        stats.down += chunk.length;
        mixStageSeed(chunk.length, 1);
        return this.down.write(Buffer.concat([STAGE_ACK, chunk]));
      }
      return this.down.write(STAGE_ACK);
    }
    if (!chunk || !chunk.length) return true;
    stats.down += chunk.length;
    mixStageSeed(chunk.length, 1);
    return this.down.write(chunk);
  }

  async push(chunk) {
    if (this.dead) throw new Error('channel closed');
    this.touch();
    stats.up += chunk.length;
    mixStageSeed(chunk.length, this.mux.size);
    if (this.state === 'stream') return this._writeRemote(chunk);
    this.rx.push(chunk);
    if (this.state === 'init') {
      await this._parseHeader();
      if (!this.dead && this.state === 'init' && this.rx.length > 1024) return this._fail('stage frame overflow');
    } else if (this.state === 'dgram') {
      this._parseUdp();
    } else if (this.state === 'arena') {
      await this._parseMux();
    }
  }

  async _writeRemote(chunk) {
    const s = this.remote;
    if (!s || s.destroyed) throw new Error('remote closed');
    if (!s.write(chunk)) await waitDrain(s);
  }

  // ── 舞台同步帧头解析（基于 ChunkList 零拷贝预览） ──
  async _parseHeader() {
    if (this.rx.length < 18) return;
    const headPreview = this.rx.peek(Math.min(this.rx.length, 540));
    if (headPreview[0] !== STAGE_REV) { noteAuthFail(this.ip); return this._fail('stage revision mismatch ' + headPreview[0]); }
    const user = findUser(headPreview.subarray(1, 17));
    if (!user) { noteAuthFail(this.ip); return this._fail('invalid player ticket'); }
    const extLen = headPreview[17];
    let p = 18 + extLen;
    if (headPreview.length < p + 1) return;
    const op = headPreview[p++];
    let host = '', port = 0;
    if (op === 1 || op === 2) {
      const r = unpackEndpointMeta(headPreview, p);
      if (!r) return;
      if (r.error) return this._fail(r.error);
      host = r.host; port = r.port; p = r.next;
    } else if (op !== 3) {
      return this._fail('unknown stage op ' + op);
    }
    clearTimeout(this.handshakeTimer);
    this.rx.consume(p);

    if (op === 1) {
      const rest = this.rx.drainAll();
      log('debug', `${this.label} stream -> ${host}:${port}`);
      let sock;
      try {
        sock = await connectTcp(host, port);
      } catch (e) {
        return this._fail(`stream connect ${host}:${port} failed: ${e.message}`);
      }
      if (this.dead) { sock.destroy(); return; }
      this.remote = sock;
      this.state = 'stream';
      this._bindRemote(sock);
      this.headerTimer = setTimeout(() => this.sendDown(null), 18 + Math.floor(Math.random() * 24));
      if (rest.length) await this._writeRemote(rest);
    } else if (op === 2) {
      log('debug', `${this.label} dgram -> ${host}:${port}`);
      this.state = 'dgram';
      this.udpTarget = { host, port };
      this.udp = new DatagramRelay((h, pt, msg) => this._udpReply(msg));
      this.sendDown(null);
      this._parseUdp();
    } else {
      log('debug', `${this.label} arena`);
      this.state = 'arena';
      this.sendDown(null);
      await this._parseMux();
    }
  }

  _bindRemote(sock) {
    sock.on('data', (c) => {
      this.touch();
      if (!this.sendDown(c)) {
        sock.pause();
        this.down.drain(() => sock.resume());
      }
    });
    sock.on('end', () => this._finishDown());
    sock.on('error', (e) => { log('debug', `${this.label} remote error: ${e.message}`); });
    sock.on('close', () => this._finishDown());
  }

  _finishDown() {
    if (this.dead) return;
    this.sendDown(null);
    this.destroy(true);
  }

  endUplink() {
    if (this.dead) return;
    if (this.state === 'init') {
      if (this.rx.length > 0) noteAuthFail(this.ip);
      this.destroy(false);
    } else if (this.state === 'stream' && this.remote && !this.remote.destroyed) {
      this.remote.end();
    } else if (this.state === 'dgram' || this.state === 'arena') {
      if (!this.uplinkGraceTimer) {
        this.uplinkGraceTimer = setTimeout(() => this.destroy(true), 5000);
        this.uplinkGraceTimer.unref();
      }
    } else {
      this.destroy(true);
    }
  }

  _parseUdp() {
    while (this.rx.length >= 2) {
      const len = this.rx.readUInt16BE(0);
      if (this.rx.length < 2 + len) return;
      this.rx.consume(2);
      const data = this.rx.take(len);
      this.udp.send(this.udpTarget.host, this.udpTarget.port, data).catch((e) => log('debug', 'dgram send failed', e.message));
    }
  }
  _udpReply(msg) {
    const frame = Buffer.allocUnsafe(2 + msg.length);
    frame.writeUInt16BE(msg.length, 0);
    msg.copy(frame, 2);
    this.sendDown(frame);
  }

  async _parseMux() {
    for (;;) {
      if (this.rx.length < 2) return;
      const mlen = this.rx.readUInt16BE(0);
      if (mlen < 4 || mlen > 512) return this._fail('bad arena meta length ' + mlen);
      if (this.rx.length < 2 + mlen) return;
      const headerSlice = this.rx.peek(2 + mlen + 2);
      const meta = headerSlice.subarray(2, 2 + mlen);
      const id = meta.readUInt16BE(0);
      const status = meta[2];
      const option = meta[3];
      let headerBytes = 2 + mlen;
      let dlen = 0;
      if (option & 1) {
        if (this.rx.length < headerBytes + 2) return;
        dlen = headerSlice.readUInt16BE(headerBytes);
        if (this.rx.length < headerBytes + 2 + dlen) return;
        headerBytes += 2;
      }
      let net_ = 0, target = null;
      if (status === 1 || (status === 2 && mlen > 4 && meta[4] === 2)) {
        net_ = meta[4];
        const r = unpackEndpointMeta(meta, 5);
        if (!r || r.error) return this._fail('bad arena address');
        target = { host: r.host, port: r.port };
      }
      this.rx.consume(headerBytes);
      const data = (option & 1) ? this.rx.take(dlen) : null;
      await this._muxFrame(id, status, option, net_, target, data);
    }
  }

  _muxSend(id, status, option, udpSrc, payload) {
    const pLen = payload ? payload.length : 0;
    if (!udpSrc) {
      const frame = Buffer.allocUnsafe(payload ? 8 + pLen : 6);
      frame[0] = 0;
      frame[1] = 4;
      frame[2] = (id >> 8) & 0xff;
      frame[3] = id & 0xff;
      frame[4] = status;
      frame[5] = option;
      if (payload) {
        frame.writeUInt16BE(pLen, 6);
        payload.copy(frame, 8);
      }
      return this.sendDown(frame);
    }
    const addrBuf = packEndpointMeta(udpSrc.host, udpSrc.port);
    const metaLen = 5 + addrBuf.length;
    const totalLen = 2 + metaLen + (payload ? 2 + pLen : 0);
    const frame = Buffer.allocUnsafe(totalLen);
    frame.writeUInt16BE(metaLen, 0);
    frame[2] = (id >> 8) & 0xff;
    frame[3] = id & 0xff;
    frame[4] = status;
    frame[5] = option;
    frame[6] = 2;
    addrBuf.copy(frame, 7);
    if (payload) {
      frame.writeUInt16BE(pLen, 2 + metaLen);
      payload.copy(frame, 4 + metaLen);
    }
    return this.sendDown(frame);
  }

  async _muxFrame(id, status, option, network, target, data) {
    let s = this.mux.get(id);
    if (status === 1) { // New
      if (s) this._muxClose(id, false);
      if (this.mux.size >= CFG.maxMux) { this._muxSend(id, 3, 2); return; }
      if (network === 2) {
        s = { kind: 'dgram', target };
        s.udp = new DatagramRelay((h, p, msg) => {
          this._muxSend(id, 2, 1, { host: h, port: p }, msg);
        }, () => {
          if (this.mux.get(id) === s) this._muxClose(id, true);
        });
        this.mux.set(id, s);
        if (data && data.length) s.udp.send(target.host, target.port, data).catch(() => {});
      } else if (network === 1) {
        const initLen = data && data.length ? data.length : 0;
        s = { kind: 'stream', target, sock: null, queue: initLen ? [data] : [], queuedBytes: initLen, ready: false };
        this.mux.set(id, s);
        connectTcp(target.host, target.port).then(async (sock) => {
          if (this.dead || this.mux.get(id) !== s) return sock.destroy();
          s.sock = sock;
          sock.on('data', (c) => {
            this.touch();
            let needDrain = false;
            for (let o = 0; o < c.length; o += 16384) {
              if (!this._muxSend(id, 2, 1, null, c.subarray(o, o + 16384))) needDrain = true;
            }
            if (needDrain) {
              sock.pause();
              this.down.drain(() => sock.resume());
            }
          });
          sock.on('error', () => {});
          sock.on('close', () => { if (this.mux.get(id) === s) { this._muxSend(id, 3, 0); this.mux.delete(id); } });
          while (s.queue.length && !sock.destroyed) {
            const q = s.queue.shift();
            s.queuedBytes -= q.length;
            if (!sock.write(q)) {
              try { await waitDrain(sock); } catch { break; }
            }
          }
          s.ready = true;
          if (s.ended && !sock.destroyed) sock.end();
        }).catch((e) => {
          log('debug', `${this.label} arena stream connect failed: ${e.message}`);
          if (this.mux.get(id) === s) { this._muxSend(id, 3, 2); this.mux.delete(id); }
        });
      }
      return;
    }
    if (status === 2) { // Keep
      if (!s || !data || !data.length) return;
      if (s.kind === 'dgram') {
        const t = target || s.target;
        s.udp.send(t.host, t.port, data).catch(() => {});
      } else if (s.ready) {
        if (!s.sock.write(data)) await waitDrain(s.sock).catch(() => {});
      } else {
        const maxQ = CFG.maxMuxQueueBytes || 512 * 1024;
        if (s.queuedBytes + data.length > maxQ) {
          this._muxClose(id, true);
          return;
        }
        s.queue.push(data);
        s.queuedBytes += data.length;
      }
      return;
    }
    if (status === 3) { // End
      if (!s) return;
      if (s.kind === 'stream' && s.sock && !s.sock.destroyed) { s.sock.end(); s.sock.destroySoon?.(); }
      else if (s.kind === 'stream' && !s.ready) s.ended = true;
      if (s.kind === 'dgram') this._muxClose(id, false);
      return;
    }
  }

  _muxClose(id, notify) {
    const s = this.mux.get(id);
    if (!s) return;
    this.mux.delete(id);
    if (s.udp) s.udp.close();
    if (s.sock) s.sock.destroy();
    if (notify) this._muxSend(id, 3, 0);
  }

  _fail(reason) {
    log('info', `${this.label} rejected: ${reason}`);
    this.destroy(false);
  }

  destroy(graceful) {
    if (this.dead) return;
    this.dead = true;
    registry.delete(this);
    this.rx.clear();
    clearTimeout(this.headerTimer);
    clearTimeout(this.handshakeTimer);
    clearTimeout(this.uplinkGraceTimer);
    if (this.remote) this.remote.destroy();
    if (this.udp) this.udp.close();
    for (const id of [...this.mux.keys()]) this._muxClose(id, false);
    if (graceful) {
      this.down.end();
      setTimeout(() => this.down.destroy(), 5000).unref();
    } else {
      this.down.destroy();
    }
    if (this.onDead) this.onDead();
  }
}

// 通道存活巡检、空闲超时与多路复用数据报子流自动回收（每 15 秒扫描一次）
setInterval(() => {
  const now = Date.now();
  const udpIdleLimit = CFG.udpIdleMs || 60000;
  for (const t of registry) {
    if (now - t.lastActive > CFG.idleMs) {
      log('debug', `${t.label} idle timeout`);
      t.destroy(false);
    } else if (t.state === 'stream' && (!t.remote || t.remote.destroyed)) {
      t.destroy(true);
    } else if (t.state === 'arena' && t.mux.size > 0) {
      for (const [id, s] of t.mux) {
        if (s.kind === 'dgram' && s.udp && now - s.udp.lastActive > udpIdleLimit) {
          t._muxClose(id, true);
        }
      }
    }
  }
}, 15000).unref();

module.exports = { Channel, registry, findUser, STAGE_REV, PROTO_VERSION: STAGE_REV };
