'use strict';
// 街机四合一核心引擎 (v2.0)：全服高分榜持久化 + 全服幽灵车轨迹回放池 + 实时网络律动与关卡种子同构耦合

const fs = require('fs');
const path = require('path');
const { stateDir } = require('./config');
const { stats, mixStageSeed } = require('./stats');
const { registry } = require('./channel');
const { sessions, sampleStageLanes } = require('./session');
const { edgeStatus } = require('./edge');
const { packEndpointMeta, unpackEndpointMeta } = require('./netutil');

const MAX_ENTRIES = 15;
const VALID_GAMES = ['snake', 'breakout', 'invaders', 'runner'];
const DEFAULT_BOARD = {
  snake: [
    { name: 'NEO', score: 420, ts: 1700000000000 },
    { name: 'TRN', score: 310, ts: 1700000000000 },
    { name: 'FLY', score: 180, ts: 1700000000000 },
  ],
  breakout: [
    { name: 'ARK', score: 680, ts: 1700000000000 },
    { name: 'VEX', score: 450, ts: 1700000000000 },
    { name: 'BIT', score: 240, ts: 1700000000000 },
  ],
  invaders: [
    { name: 'ACE', score: 920, ts: 1700000000000 },
    { name: 'NOVA', score: 610, ts: 1700000000000 },
    { name: 'ION', score: 350, ts: 1700000000000 },
  ],
  runner: [
    { name: 'SYN', score: 1280, ts: 1700000000000 },
    { name: 'KAI', score: 860, ts: 1700000000000 },
    { name: 'ZED', score: 540, ts: 1700000000000 },
  ],
  plays: 0,
};

let board = null;
let saveTimer = null;
let dirty = false;
let saving = false;

// 全服幽灵回放轨迹环形池（记录最近 12 个操作关键帧，与前端同屏幽灵残影同步）
const ghostFrames = [
  { g: 'runner', y: 365, s: 1 },
  { g: 'runner', y: 312, s: 1 },
  { g: 'runner', y: 284, s: 2 },
  { g: 'runner', y: 365, s: 2 },
];

function scoreFile() {
  const dir = stateDir();
  return dir ? path.join(dir, 'arcade-scores.json') : null;
}

function loadBoard() {
  if (board) return board;
  const f = scoreFile();
  if (f) {
    try {
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (raw && Array.isArray(raw.snake) && Array.isArray(raw.breakout)) {
        board = {
          snake: raw.snake.slice(0, MAX_ENTRIES),
          breakout: raw.breakout.slice(0, MAX_ENTRIES),
          invaders: Array.isArray(raw.invaders) ? raw.invaders.slice(0, MAX_ENTRIES) : JSON.parse(JSON.stringify(DEFAULT_BOARD.invaders)),
          runner: Array.isArray(raw.runner) ? raw.runner.slice(0, MAX_ENTRIES) : JSON.parse(JSON.stringify(DEFAULT_BOARD.runner)),
          plays: Number(raw.plays) || 0,
        };
        return board;
      }
    } catch {}
  }
  board = JSON.parse(JSON.stringify(DEFAULT_BOARD));
  return board;
}

async function flushBoardAsync() {
  saveTimer = null;
  if (!dirty || saving || !board) return;
  const f = scoreFile();
  if (!f) return;
  dirty = false;
  saving = true;
  try {
    const tmp = `${f}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, JSON.stringify(board, null, 2) + '\n', { mode: 0o600 });
    await fs.promises.rename(tmp, f);
  } catch {
    dirty = true;
  } finally {
    saving = false;
    if (dirty && !saveTimer) saveTimer = setTimeout(flushBoardAsync, 2000).unref();
  }
}

function flushBoardSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!dirty || !board) return;
  const f = scoreFile();
  if (!f) return;
  dirty = false;
  try {
    const tmp = `${f}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(board, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, f);
  } catch {}
}

function scheduleSave() {
  dirty = true;
  if (!saveTimer && !saving) {
    saveTimer = setTimeout(flushBoardAsync, 1000).unref();
  }
}

process.on('exit', flushBoardSync);

function sanitizeName(raw) {
  const s = String(raw || '').trim().replace(/[^\w\u4e00-\u9fa5-]/g, '').slice(0, 8);
  return s || 'ANON';
}

const submitRates = new Map();
function allowSubmit(ip) {
  if (!ip) return true;
  const now = Date.now();
  let r = submitRates.get(ip);
  if (!r || now - r.t > 10000) {
    r = { n: 0, t: now };
    submitRates.set(ip, r);
  }
  r.n++;
  if (submitRates.size > 4096) submitRates.delete(submitRates.keys().next().value);
  return r.n <= 5;
}

function recordScore(game, name, score, ip) {
  if (!allowSubmit(ip)) return { ok: false, error: 'rate limited', status: 429 };
  if (!VALID_GAMES.includes(game)) return { ok: false, error: 'invalid game', status: 400 };
  const n = Math.floor(Number(score));
  if (!Number.isFinite(n) || n < 0 || n > 999999) return { ok: false, error: 'invalid score', status: 400 };
  const b = loadBoard();
  b.plays++;
  const cleanName = sanitizeName(name);
  let rank = null;
  if (n > 0) {
    const list = b[game];
    const entry = { name: cleanName, score: n, ts: Date.now() };
    list.push(entry);
    list.sort((a, x) => x.score - a.score || a.ts - x.ts);
    rank = list.indexOf(entry) + 1;
    if (list.length > MAX_ENTRIES) list.length = MAX_ENTRIES;
    if (rank > MAX_ENTRIES) rank = null;
  }
  mixStageSeed(n, b.plays);
  scheduleSave();
  cachedPulseBuf = null;
  return { ok: true, rank, high: b[game][0] ? b[game][0].score : 0, leaderboard: b[game].slice(0, 10) };
}

// ──────────────────── 实时流量采样 → 游戏能量场与关卡地形流（每秒滑动 + 序列化缓存） ────────────────────
let lastBytes = 0;
let lastSampleAt = Date.now();
let currentBps = 0;
let cachedPulseBuf = null;
let cachedPulseAt = 0;

setInterval(() => {
  const now = Date.now();
  const dt = Math.max(0.2, (now - lastSampleAt) / 1000);
  const total = stats.up + stats.down;
  const inst = Math.max(0, (total - lastBytes) / dt);
  currentBps = Math.round(currentBps * 0.4 + inst * 0.6);
  lastBytes = total;
  lastSampleAt = now;
  cachedPulseBuf = null;
}, 1000).unref();

function getPulse() {
  const b = loadBoard();
  const edge = edgeStatus();
  const active = registry.size;
  const fluxBoost = currentBps > 0 ? Math.min(1.6, Math.log10(currentBps + 10) / 4.2) : 0;
  const connBoost = Math.min(0.4, active * 0.04);
  const multiplier = Number((1 + fluxBoost + connBoost).toFixed(2));
  const phase = edge.enabled ? (edge.ready ? 'WARP-LOCKED' : 'SYNCING') : (active > 0 || currentBps > 512 ? 'OVERDRIVE' : 'STANDBY');

  const sectorFrame = packEndpointMeta('127.0.0.1', (stats.stageSector % 60000) + 1000);
  const sectorMeta = unpackEndpointMeta(sectorFrame, 0);
  const verifiedSector = sectorMeta ? (sectorMeta.port - 1000) : stats.stageSector;

  return {
    engine: 'neon-arcade/2.0',
    ts: Date.now(),
    pulse: {
      phase,
      flux: currentBps,
      nodes: Math.max(1, active + sessions.size),
      multiplier,
      starSpeed: Number((1 + (multiplier - 1) * 1.8).toFixed(2)),
      totalPlays: b.plays + stats.total,
      stageSeed: stats.stageSeed,
      stageSector: verifiedSector,
      lanes: sampleStageLanes(stats.stageSeed),
      ghost: ghostFrames.slice(-8),
    },
    leaderboard: {
      snake: b.snake.slice(0, 8),
      breakout: b.breakout.slice(0, 8),
      invaders: b.invaders.slice(0, 8),
      runner: b.runner.slice(0, 8),
    },
  };
}

function getPulseBuffer() {
  const now = Date.now();
  if (cachedPulseBuf && now - cachedPulseAt < 1000) return cachedPulseBuf;
  cachedPulseBuf = Buffer.from(JSON.stringify(getPulse()), 'utf8');
  cachedPulseAt = now;
  return cachedPulseBuf;
}

const telemetryRates = new Map();
function recordTelemetry(rawOrBytes, ip) {
  const bytes = Buffer.isBuffer(rawOrBytes) ? rawOrBytes.length : Number(rawOrBytes) || 0;
  if (bytes <= 0) return;
  if (ip) {
    const now = Date.now();
    let r = telemetryRates.get(ip);
    if (!r || now - r.t > 10000) {
      r = { n: 0, t: now };
      telemetryRates.set(ip, r);
    }
    r.n++;
    if (telemetryRates.size > 4096) telemetryRates.delete(telemetryRates.keys().next().value);
    if (r.n > 40) return;
  }
  stats.up += bytes;
  mixStageSeed(bytes, stats.stageSector);
  if (Buffer.isBuffer(rawOrBytes) && rawOrBytes.length <= 512) {
    try {
      const obj = JSON.parse(rawOrBytes.toString('utf8'));
      if (obj && obj.g && obj.d) {
        ghostFrames.push({
          g: String(obj.g).slice(0, 12),
          x: Number(obj.d.x) || 0,
          y: Number(obj.d.y) || 365,
          s: Number(obj.d.sector || obj.d.w) || 1,
        });
        if (ghostFrames.length > 16) ghostFrames.shift();
      }
    } catch {}
  }
}

module.exports = { getPulse, getPulseBuffer, recordScore, recordTelemetry, loadBoard, flushBoardSync };
