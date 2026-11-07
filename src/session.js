'use strict';

const { CFG } = require('./config');
const { mixStageSeed } = require('./stats');

// ───────────────────────────── 舞台帧序列会话（分包重排 + 赛博疾行地形流耦合） ─────────────────────────────

const sessions = new Map();
const MAX_SESSIONS = 8192;
const closedSessions = new Map();
let totalReserved = 0;
const globalCapWaiters = [];
function getTotalReserved() { return totalReserved; }
function tombstone(id) {
  closedSessions.set(id, Date.now() + 120000);
  if (closedSessions.size > 20000) closedSessions.delete(closedSessions.keys().next().value);
}

class Session {
  constructor(id) {
    this.id = id;
    this.nextSeq = 0;
    this.pending = new Map();
    this.channel = null;
    this.draining = false;
    this.closed = false;
    this.streamUp = false;
    this.waiters = [];
    this.capWaiters = [];
    this.reserved = 0;
    this.gapTimer = null;
    this.stageSignature = (parseInt(String(id).slice(0, 8), 16) || 0x13579bdf) >>> 0;
    // 30 秒内没有建立下行事件流连接则自动回收会话
    this.reapTimer = setTimeout(() => this.close(), 30000);
    this.reapTimer.unref();
  }

  // 乱序空洞熔断看门狗：若后续帧已到达但当前急需的 nextSeq 停滞超过 seqGapStallMs (15s) 仍未补齐，主动熔断回收
  _syncGapTimer() {
    if (this.closed || this.pending.size === 0 || this.pending.has(this.nextSeq)) {
      if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
      return;
    }
    if (!this.gapTimer) {
      const stallMs = CFG.seqGapStallMs || 15000;
      this.gapTimer = setTimeout(() => {
        this.gapTimer = null;
        if (!this.closed && this.pending.size > 0 && !this.pending.has(this.nextSeq)) {
          this.close();
        }
      }, stallMs);
      this.gapTimer.unref();
    }
  }

  // 会话是否已完成首帧校验并进入活跃同步态
  isAuth() {
    return !!(this.channel && !this.channel.dead && this.channel.state !== 'init');
  }

  attach(channel) {
    clearTimeout(this.reapTimer);
    this.channel = channel;
    channel.onDead = () => this.close();
    for (const w of this.waiters) w();
    this.waiters = [];
    this._drain();
  }

  whenAttached() {
    if (this.channel) return Promise.resolve();
    if (this.closed) return Promise.reject(new Error('session closed'));
    return new Promise((res) => this.waiters.push(res));
  }

  push(seq, data) {
    if (this.closed) return Promise.reject(new Error('session closed'));
    if (seq < this.nextSeq || this.pending.has(seq)) return Promise.reject(new Error('duplicate seq ' + seq));
    if (seq - this.nextSeq > CFG.maxSeqGap) return Promise.reject(new Error('seq too far ahead'));
    mixStageSeed(data ? data.length : 0, seq);
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { data, resolve, reject });
      this._drain();
    });
  }

  // 双层准入流控：
  // 1) 序号恰为 nextSeq 的帧无条件放行（确保 seq=0 首帧或当前急需顺序帧绝不死锁）；
  // 2) 未完成首帧校验前限制乱序缓冲为 preAuthBufferBytes (2MB)，校验通过后自动解锁至 maxBufferBytes (64MB)，同时受全局总配额 maxTotalBufferBytes (128MB) 约束。
  async admit(seq, n) {
    while (!this.closed && seq !== this.nextSeq) {
      const limit = this.isAuth() ? CFG.maxBufferBytes : (CFG.preAuthBufferBytes || 2 * 1024 * 1024);
      const totalLimit = CFG.maxTotalBufferBytes || 128 * 1024 * 1024;
      if (this.reserved < limit && totalReserved < totalLimit) break;
      await new Promise((r) => {
        this.capWaiters.push(r);
        globalCapWaiters.push(r);
      });
    }
    if (this.closed) throw new Error('session closed');
    this.reserved += n;
    totalReserved += n;
  }
  release(n) {
    const dec = Math.min(this.reserved, n);
    this.reserved -= dec;
    totalReserved = Math.max(0, totalReserved - dec);
    this._wake();
  }
  _wake() {
    const w = this.capWaiters;
    this.capWaiters = [];
    for (const f of w) f();
    if (globalCapWaiters.length) {
      const gw = globalCapWaiters.splice(0, 64);
      for (const f of gw) f();
    }
  }

  async _drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.closed && this.channel) {
        const item = this.pending.get(this.nextSeq);
        if (!item) break;
        this.pending.delete(this.nextSeq);
        this.nextSeq++;
        if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
        this._wake();
        try {
          if (item.data.length) await this.channel.push(item.data);
          this._wake();
          item.resolve();
        } catch (e) {
          item.reject(e);
        }
      }
      this._syncGapTimer();
    } finally {
      this.draining = false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reapTimer);
    if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    if (this.reserved > 0) {
      totalReserved = Math.max(0, totalReserved - this.reserved);
      this.reserved = 0;
    }
    if (sessions.get(this.id) === this) { sessions.delete(this.id); tombstone(this.id); }
    for (const it of this.pending.values()) it.reject(new Error('session closed'));
    this.pending.clear();
    for (const w of this.waiters) w();
    this.waiters = [];
    this._wake();
    if (this.channel) this.channel.destroy(false);
  }
}

function upsertSession(id) {
  let s = sessions.get(id);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      for (const cand of sessions.values()) {
        if (!cand.isAuth()) {
          cand.close();
          break;
        }
      }
      if (sessions.size >= MAX_SESSIONS) return null;
    }
    s = new Session(id);
    sessions.set(id, s);
  }
  return s;
}

// 从当前活跃帧会话与墓碑池提取 4 车道障碍物排列特征（供赛博疾行 CYBER RUNNER 实时关卡生成使用）
function sampleStageLanes(baseSeed) {
  let acc = (baseSeed >>> 0) ^ (sessions.size * 0x9e3779b1);
  let i = 0;
  for (const s of sessions.values()) {
    acc = (acc ^ ((s.nextSeq + s.pending.size) << (i % 16)) ^ s.stageSignature) >>> 0;
    if (++i >= 8) break;
  }
  return [
    (acc & 0x03),
    ((acc >>> 3) & 0x03),
    ((acc >>> 6) & 0x03),
    ((acc >>> 9) & 0x03),
  ];
}

// 定期清理过期的会话墓碑
setInterval(() => {
  const now = Date.now();
  for (const [id, exp] of closedSessions) if (exp <= now) closedSessions.delete(id);
}, 15000).unref();

module.exports = { Session, sessions, closedSessions, tombstone, upsertSession, sampleStageLanes, getTotalReserved, MAX_SESSIONS };
