'use strict';
// 日志：支持 error | info | debug 三级，标准流分离输出

const { CFG } = require('./config');

const LEVELS = { error: 0, info: 1, debug: 2 };
function log(level, ...a) {
  if (LEVELS[level] <= (LEVELS[CFG.logLevel] ?? 1)) {
    const out = level === 'error' ? console.error : console.log;
    out(`[${new Date().toISOString()}] [${level}]`, ...a);
  }
}

module.exports = { log, LEVELS };
