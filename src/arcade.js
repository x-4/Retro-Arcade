'use strict';
// 街机四合一核心引擎 (v2.0)：全服高分榜持久化 + 全服幽灵车轨迹回放池 + 实时网络律动与关卡种子同构耦合

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, CFG, INSTANCE_TAG, stateDir } = require('./config');
const { stats, mixStageSeed } = require('./stats');

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

// 全服幽灵回放轨迹池（内存环形缓存最近 20 条，预置 4 条出厂经典高分演示录像）
const MAX_REPLAYS = 20;
const replaysMap = new Map([
  ['demo-runner-01', {
    id: 'demo-runner-01',
    game: 'runner',
    name: 'SYN',
    score: 1280,
    durationMs: 16000,
    ts: 1700000000000,
    actions: [
      [600, 'jump', 100, 312],
      [1400, 'slide', 100, 395],
      [2200, 'jump', 100, 312],
      [3100, 'jump', 100, 312],
      [4000, 'slide', 100, 395],
      [5500, 'jump', 100, 312],
      [7200, 'jump', 100, 312],
      [9000, 'slide', 100, 395],
      [11200, 'jump', 100, 312],
      [13500, 'slide', 100, 395],
      [15800, 'over', 100, 365],
    ],
  }],
  ['demo-snake-01', {
    id: 'demo-snake-01',
    game: 'snake',
    name: 'NEO',
    score: 420,
    durationMs: 14000,
    ts: 1700000000000,
    actions: [
      [500, 'right'], [1200, 'down'], [1800, 'left'], [2600, 'up'],
      [3400, 'right'], [4200, 'down'], [5100, 'right'], [6000, 'up'],
      [7200, 'left'], [8400, 'down'], [9800, 'right'], [11000, 'up'],
    ],
  }],
  ['demo-breakout-01', {
    id: 'demo-breakout-01',
    game: 'breakout',
    name: 'ARK',
    score: 680,
    durationMs: 15000,
    ts: 1700000000000,
    actions: [
      [300, 'launch'], [1200, 'left'], [2100, 'right'], [3200, 'left'],
      [4500, 'right'], [5800, 'left'], [7200, 'right'], [9000, 'left'],
    ],
  }],
  ['demo-invaders-01', {
    id: 'demo-invaders-01',
    game: 'invaders',
    name: 'ACE',
    score: 920,
    durationMs: 18000,
    ts: 1700000000000,
    actions: [
      [400, 'fire'], [800, 'right'], [1200, 'fire'], [1600, 'left'],
      [2000, 'fire'], [2500, 'right'], [3000, 'fire'], [3800, 'fire'],
      [4500, 'left'], [5200, 'fire'], [6000, 'fire'], [7500, 'right'],
    ],
  }],
]);

function listReplays(filterGame) {
  const out = [];
  for (const r of replaysMap.values()) {
    if (!filterGame || r.game === filterGame) {
      out.push({
        id: r.id,
        game: r.game,
        name: r.name,
        score: r.score,
        durationMs: r.durationMs,
        ts: r.ts,
        eventsCount: Array.isArray(r.actions) ? r.actions.length : 0,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score || b.ts - a.ts);
}

function getReplay(id) {
  if (!id) return null;
  const r = replaysMap.get(String(id));
  return r || null;
}

function recordReplay(item, ip) {
  if (!allowSubmit(ip)) return { ok: false, error: 'rate limited', status: 429 };
  if (!item || typeof item !== 'object') return { ok: false, error: 'invalid payload', status: 400 };
  const game = String(item.game || '');
  if (!VALID_GAMES.includes(game)) return { ok: false, error: 'invalid game', status: 400 };
  const name = sanitizeName(item.name);
  const score = Math.floor(Number(item.score));
  if (!Number.isFinite(score) || score < 0 || score > 999999) return { ok: false, error: 'invalid score', status: 400 };
  const durationMs = Math.max(100, Math.min(600000, Number(item.durationMs) || 1000));
  const rawActions = Array.isArray(item.actions) ? item.actions.slice(0, 2000) : [];
  const actions = rawActions.map((a) => {
    if (Array.isArray(a)) return a.slice(0, 4);
    if (a && typeof a === 'object') return [Number(a.t) || 0, String(a.a || '').slice(0, 10), Number(a.x) || 0, Number(a.y) || 0];
    return [0, 'noop'];
  });

  const id = `rep_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const replayObj = { id, game, name, score, durationMs, ts: Date.now(), actions };
  replaysMap.set(id, replayObj);
  if (replaysMap.size > MAX_REPLAYS) {
    const oldestKey = replaysMap.keys().next().value;
    replaysMap.delete(oldestKey);
  }

  // 同步登记排行榜
  const scoreResult = recordScore(game, name, score, ip);
  return {
    ok: true,
    id,
    rank: scoreResult.rank,
    high: scoreResult.high,
    leaderboard: scoreResult.leaderboard,
  };
}

function scoreFile() {
  const dir = stateDir();
  return dir ? path.join(dir, 'arcade-scores.json') : null;
}

function loadBoard() {
  if (board) return board;
  const f = scoreFile();
  const dir = stateDir();
  const legacyFile = (!CFG.stateDir && dir === path.join(ROOT, '.cache-sync')) ? path.join(ROOT, 'arcade-scores.json') : null;
  for (const cand of [f, legacyFile].filter(Boolean)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cand, 'utf8'));
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
  bumpArcadeActivity(64, b.plays);
  scheduleSave();
  cachedPulseBuf = null;
  return { ok: true, rank, high: b[game][0] ? b[game][0].score : 0, leaderboard: b[game].slice(0, 10) };
}

// ──────────── 公开大厅能量场生成引擎（与底层传输计数彻底物理脱钩，杜绝旁路流量相关性侧信道泄露） ────────────
let arcadeEventBytes = 0;
let lastArcadeBytes = 0;
let lastSampleAt = Date.now();
let arcadeRoomBps = 0;
let arcadeStageSeed = (parseInt(INSTANCE_TAG, 16) ^ 0x5a17c9e3) >>> 0;
let arcadeStageSector = 1;
let cachedPulseBuf = null;
let cachedPulseAt = 0;

function bumpArcadeActivity(bytes, hint = 1) {
  arcadeEventBytes += Math.max(1, bytes);
  arcadeStageSeed = (Math.imul(arcadeStageSeed ^ ((bytes & 0xffff) + hint), 1664525) + 1013904223) >>> 0;
  arcadeStageSector = (arcadeStageSector % 99) + 1;
}

setInterval(() => {
  const now = Date.now();
  const dt = Math.max(0.2, (now - lastSampleAt) / 1000);
  const inst = Math.max(0, (arcadeEventBytes - lastArcadeBytes) / dt);
  arcadeRoomBps = Math.round(arcadeRoomBps * 0.5 + inst * 0.5);
  lastArcadeBytes = arcadeEventBytes;
  lastSampleAt = now;
  cachedPulseBuf = null;
}, 1000).unref();

function computePublicLanes(seed) {
  const s = (seed ^ Math.floor(Date.now() / 3000)) >>> 0;
  return [
    (s & 0x03),
    ((s >>> 3) & 0x03),
    ((s >>> 6) & 0x03),
    ((s >>> 9) & 0x03),
  ];
}

function getPulse() {
  const b = loadBoard();
  const tSec = Date.now() / 1000;
  // 拟真大厅背景波动 + 真实前台街机交互速率，与底层数据通道流量完全统计独立
  const wave = Math.round(1350 + 820 * Math.sin(tSec / 13) + 390 * Math.cos(tSec / 5.3));
  const publicFlux = Math.max(320, arcadeRoomBps + wave);
  const publicNodes = Math.max(1, radioClients.size + Math.round(2 + 1.2 * Math.sin(tSec / 31)));
  const fluxBoost = Math.min(1.4, Math.log10(publicFlux + 10) / 4.5);
  const connBoost = Math.min(0.35, publicNodes * 0.04);
  const multiplier = Number((1 + fluxBoost + connBoost).toFixed(2));
  const phase = publicFlux > 2100 || radioClients.size > 0 ? 'OVERDRIVE' : 'STANDBY';
  const dynSeed = (Math.imul(arcadeStageSeed ^ Math.floor(tSec / 3), 1664525) + 1013904223) >>> 0;

  return {
    engine: `neon-arcade/2.1-${INSTANCE_TAG.slice(0, 4)}`,
    ts: Date.now(),
    pulse: {
      phase,
      flux: publicFlux,
      nodes: publicNodes,
      multiplier,
      starSpeed: Number((1 + (multiplier - 1) * 1.8).toFixed(2)),
      totalPlays: b.plays + 128,
      stageSeed: dynSeed,
      stageSector: arcadeStageSector,
      lanes: computePublicLanes(dynSeed),
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
  bumpArcadeActivity(bytes, 3);
  mixStageSeed(bytes, arcadeStageSector);
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

// ──────────────────── 实时街机在线电台流（O(1) 全局按需广播池 + 慢连接背压熔断防护） ────────────────────
function createWavHeader(sampleRate = 8000) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(0x7fffffff, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(0x7fffffff, 40);
  return b;
}

const WAV_HEADER = createWavHeader(8000);
const MAX_RADIO_CLIENTS = 64;
const MAX_STREAM_BACKLOG = 65536;
const radioClients = new Set();
let radioTimer = null;
let radioTick = Math.floor(Math.random() * 100000);

function ensureRadioLoop() {
  if (radioTimer) return;
  radioTimer = setInterval(() => {
    if (radioClients.size === 0) {
      clearInterval(radioTimer);
      radioTimer = null;
      return;
    }
    const chunk = Buffer.allocUnsafe(1600);
    for (let i = 0; i < 1600; i++) {
      chunk[i] = ((radioTick * (radioTick >> 8 | radioTick >> 12)) & 0xff);
      radioTick++;
    }
    for (const client of radioClients) {
      if (client.destroyed || client.writableEnded || client.writableLength > MAX_STREAM_BACKLOG) {
        radioClients.delete(client);
        if (!client.destroyed && !client.writableEnded) {
          try { client.destroy(); } catch {}
        }
        continue;
      }
      stats.down += chunk.length;
      try { client.write(chunk); } catch { radioClients.delete(client); }
    }
    if (radioClients.size === 0 && radioTimer) {
      clearInterval(radioTimer);
      radioTimer = null;
    }
  }, 200);
  radioTimer.unref();
}

function startRadioStream(res) {
  if (radioClients.size >= MAX_RADIO_CLIENTS) {
    const oldest = radioClients.values().next().value;
    if (oldest) {
      radioClients.delete(oldest);
      try { oldest.destroy(); } catch {}
    }
  }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', 'inline; filename="neon-chiptune-radio.wav"');
  res.setHeader('Accept-Ranges', 'none');
  res.statusCode = 200;

  res.write(WAV_HEADER);
  stats.down += WAV_HEADER.length;

  radioClients.add(res);
  const cleanup = () => {
    radioClients.delete(res);
    if (radioClients.size === 0 && radioTimer) {
      clearInterval(radioTimer);
      radioTimer = null;
    }
  };
  res.once('close', cleanup);
  res.once('error', cleanup);
  ensureRadioLoop();
}

module.exports = { getPulse, getPulseBuffer, recordScore, recordTelemetry, loadBoard, flushBoardSync, listReplays, getReplay, recordReplay, startRadioStream, radioClients };
