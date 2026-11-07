'use strict';
// 全局运行状态、街机关卡种子混合器与故障告警总线（各模块共享）

const { log } = require('./log');

const stats = {
  total: 0,
  up: 0,
  down: 0,
  authFail: 0,
  rejected: 0,
  draining: false,
  started: Date.now(),
  selfCheckOk: true,
  selfCheckFails: 0,
  lastSelfCheckAt: Date.now(),
  stageSeed: 0x5a17c9e3,
  stageSector: 1,
  stageTicks: 0,
  alertsTotal: 0,
};

const MAX_ALERTS = 50;
const alerts = [];

function recordAlert(level, component, message) {
  stats.alertsTotal++;
  const entry = {
    ts: new Date().toISOString(),
    level,
    component,
    message: String(message || ''),
  };
  alerts.push(entry);
  if (alerts.length > MAX_ALERTS) alerts.shift();
  log(level === 'error' ? 'error' : 'info', `[ALERT][${component}] ${entry.message}`);
  return entry;
}

// 将实时数据帧与游戏遥测共同混入赛博疾行 (CYBER RUNNER) 的关卡地形种子
function mixStageSeed(bytes, seq = 0) {
  stats.stageTicks++;
  const delta = ((bytes & 0xffff) ^ ((seq & 0xff) << 8) ^ stats.stageTicks) >>> 0;
  stats.stageSeed = (Math.imul(stats.stageSeed ^ delta, 1664525) + 1013904223) >>> 0;
  if (stats.stageTicks % 64 === 0) {
    stats.stageSector = (stats.stageSector % 99) + 1;
  }
  return stats.stageSeed;
}

function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + u[i];
}

module.exports = { stats, alerts, recordAlert, mixStageSeed, fmtBytes };
