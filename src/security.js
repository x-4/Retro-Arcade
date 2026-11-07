'use strict';
// 安全：认证失败封禁、恒定时间字符串比较

const crypto = require('crypto');
const { CFG } = require('./config');
const { log } = require('./log');
const { stats } = require('./stats');
const { isPrivateIP } = require('./netutil');

// 认证失败封禁：同一来源 IP 在窗口内失败次数过多就暂时拒绝（内网/回环地址不封，避免误伤本地网关）
const authFails = new Map();
function noteAuthFail(ip) {
  stats.authFail++;
  if (!CFG.banMax || !ip || isPrivateIP(ip)) return;
  const now = Date.now();
  let e = authFails.get(ip);
  if (!e || now - e.first > CFG.banWindowMs) { e = { n: 0, first: now, until: 0 }; authFails.set(ip, e); }
  e.n++;
  if (e.n >= CFG.banMax && !e.until) { e.until = now + CFG.banTimeMs; log('info', `封禁 ${ip} ${Math.round(CFG.banTimeMs / 1000)} 秒（认证失败 ${e.n} 次）`); }
  if (authFails.size > 20000) authFails.delete(authFails.keys().next().value);
}
function isBanned(ip) {
  const e = authFails.get(ip);
  if (!e || !e.until) return false;
  if (e.until > Date.now()) return true;
  authFails.delete(ip);
  return false;
}

function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 定期清理过期的封禁/计数记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of authFails) {
    if (e.until ? e.until <= now : now - e.first > CFG.banWindowMs) authFails.delete(ip);
  }
}, 15000).unref();

module.exports = { authFails, noteAuthFail, isBanned, safeEq };
