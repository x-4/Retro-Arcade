'use strict';
// 街机实时网络接入层：单端口 HTTP/1.1 + h2c 首包嗅探、连接窗口调优与 H2 心跳保活

const http = require('http');
const http2 = require('http2');
const net = require('net');
const { log } = require('./log');
const { handler } = require('./router');

const H2_SETTINGS = { maxConcurrentStreams: 1024, initialWindowSize: 8 * 1024 * 1024, maxHeaderListSize: 65536 };

function tuneH2(server) {
  server.on('session', (s) => {
    try { s.setLocalWindowSize(32 * 1024 * 1024); } catch {}
    s.on('error', (e) => log('debug', 'h2 session error:', e.message));
    // 周期性 HTTP/2 PING 保活：防止长连接被中间网络设备静默掐断，同时自动清理僵死会话
    const pingIv = setInterval(() => {
      if (s.closed || s.destroyed) { clearInterval(pingIv); return; }
      try {
        s.ping((err) => {
          if (err && !s.destroyed) {
            clearInterval(pingIv);
            try { s.destroy(); } catch {}
          }
        });
      } catch {
        clearInterval(pingIv);
      }
    }, 25000);
    pingIv.unref();
    s.once('close', () => clearInterval(pingIv));
  });
  server.on('sessionError', (e) => log('debug', 'h2 sessionError:', e.message));
}

function createServer() {
  const h1 = http.createServer({ maxHeaderSize: 65536, noDelay: true }, handler);
  h1.requestTimeout = 0;
  h1.headersTimeout = 15000;
  h1.timeout = 0;
  h1.keepAliveTimeout = 65000;
  h1.on('clientError', (e, sock) => { if (sock.writable) sock.destroy(); });
  const h2 = http2.createServer({ settings: H2_SETTINGS, maxSessionMemory: 256 }, handler);
  tuneH2(h2);

  const route = (sock) => {
    sock.on('error', () => {});
    try { sock.setNoDelay(true); sock.setKeepAlive(true, 30000); } catch {}
    // 对端已发 FIN（CLOSE_WAIT）后若 10 秒仍未关闭则强制回收，杜绝句柄泄漏
    sock.on('end', () => {
      const t = setTimeout(() => { if (!sock.destroyed) sock.destroy(); }, 10000);
      t.unref();
      sock.once('close', () => clearTimeout(t));
    });
    sock.setTimeout(15000, () => sock.destroy());
    sock.once('readable', () => {
      sock.setTimeout(0);
      const chunk = sock.read();
      if (!chunk) return sock.destroy();
      sock.unshift(chunk);
      (chunk.length >= 4 && chunk.toString('latin1', 0, 4) === 'PRI ' ? h2 : h1).emit('connection', sock);
    });
  };

  return net.createServer({ allowHalfOpen: false }, route);
}

module.exports = { createServer, H2_SETTINGS };
