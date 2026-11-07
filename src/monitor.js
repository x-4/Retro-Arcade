'use strict';
// 运行状态快照 + Prometheus 指标导出 + 内嵌式复古像素管理控制台 + 周期性统计日志

const { CFG } = require('./config');
const { log } = require('./log');
const { stats, alerts, fmtBytes } = require('./stats');
const { authFails } = require('./security');
const { registry } = require('./channel');
const { sessions } = require('./session');
const { edgeStatus } = require('./edge');

function snapshot() {
  const edge = edgeStatus();
  return {
    uptimeSec: Math.round((Date.now() - stats.started) / 1000),
    draining: stats.draining,
    selfCheck: {
      ok: stats.selfCheckOk,
      fails: stats.selfCheckFails,
      lastAt: stats.lastSelfCheckAt,
    },
    activeChannels: registry.size,
    sessions: sessions.size,
    totalChannels: stats.total,
    bytesUp: stats.up,
    bytesDown: stats.down,
    authFailures: stats.authFail,
    rejected: stats.rejected,
    banned: [...authFails.values()].filter((e) => e.until > Date.now()).length,
    alertsTotal: stats.alertsTotal,
    recentAlerts: alerts.slice(-10),
    rssMB: Math.round(process.memoryUsage.rss() / 1048576),
    node: process.version,
    ...(edge.enabled ? { edge } : {}),
  };
}

function prometheusMetrics() {
  const s = snapshot();
  const edge = edgeStatus();
  const lines = [
    '# HELP arcade_uptime_seconds Server uptime in seconds',
    '# TYPE arcade_uptime_seconds gauge',
    `arcade_uptime_seconds ${s.uptimeSec}`,
    '# HELP arcade_draining Whether the server is draining connections for shutdown',
    '# TYPE arcade_draining gauge',
    `arcade_draining ${s.draining ? 1 : 0}`,
    '# HELP arcade_selfcheck_ok Whether local loopback liveness watchdog is healthy',
    '# TYPE arcade_selfcheck_ok gauge',
    `arcade_selfcheck_ok ${s.selfCheck.ok ? 1 : 0}`,
    '# HELP arcade_alerts_total Total fault alerts recorded since startup',
    '# TYPE arcade_alerts_total counter',
    `arcade_alerts_total ${s.alertsTotal}`,
    '# HELP arcade_active_channels Currently active realtime sync channels',
    '# TYPE arcade_active_channels gauge',
    `arcade_active_channels ${s.activeChannels}`,
    '# HELP arcade_active_sessions Currently active sync sessions',
    '# TYPE arcade_active_sessions gauge',
    `arcade_active_sessions ${s.sessions}`,
    '# HELP arcade_channels_total Total realtime channels created since startup',
    '# TYPE arcade_channels_total counter',
    `arcade_channels_total ${s.totalChannels}`,
    '# HELP arcade_bytes_up_total Total uplink bytes transferred',
    '# TYPE arcade_bytes_up_total counter',
    `arcade_bytes_up_total ${s.bytesUp}`,
    '# HELP arcade_bytes_down_total Total downlink bytes transferred',
    '# TYPE arcade_bytes_down_total counter',
    `arcade_bytes_down_total ${s.bytesDown}`,
    '# HELP arcade_auth_failures_total Total session authentication failures',
    '# TYPE arcade_auth_failures_total counter',
    `arcade_auth_failures_total ${s.authFailures}`,
    '# HELP arcade_rejected_requests_total Total rejected requests (banned IP or overloaded)',
    '# TYPE arcade_rejected_requests_total counter',
    `arcade_rejected_requests_total ${s.rejected}`,
    '# HELP arcade_banned_ips Currently banned client IPs',
    '# TYPE arcade_banned_ips gauge',
    `arcade_banned_ips ${s.banned}`,
    '# HELP process_resident_memory_bytes Resident memory size in bytes',
    '# TYPE process_resident_memory_bytes gauge',
    `process_resident_memory_bytes ${process.memoryUsage.rss()}`,
    '# HELP arcade_edge_enabled Whether edge sync worker supervision is enabled',
    '# TYPE arcade_edge_enabled gauge',
    `arcade_edge_enabled ${edge.enabled ? 1 : 0}`,
  ];
  if (edge.enabled) {
    lines.push(
      '# HELP arcade_edge_ready Whether the edge sync worker is ready',
      '# TYPE arcade_edge_ready gauge',
      `arcade_edge_ready ${edge.ready ? 1 : 0}`,
      '# HELP arcade_edge_ha_connections Active high-availability edge connections',
      '# TYPE arcade_edge_ha_connections gauge',
      `arcade_edge_ha_connections ${edge.haConnections || 0}`,
      '# HELP arcade_edge_requests_total Total requests routed through edge sync worker',
      '# TYPE arcade_edge_requests_total counter',
      `arcade_edge_requests_total ${edge.totalRequests || 0}`,
      '# HELP arcade_edge_restarts_total Total edge sync worker restarts',
      '# TYPE arcade_edge_restarts_total counter',
      `arcade_edge_restarts_total ${edge.restarts || 0}`
    );
  }
  return lines.join('\n') + '\n';
}

// 内嵌式复古像素 CRT 监控与配置导出面板（GET /api/v1/console/<UUID>）
function renderAdminHtml(uuidText) {
  const safeId = encodeURIComponent(uuidText);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>NEON PIXEL // STAGE CONSOLE</title>
<style>
  :root{--bg:#05060c;--card:#0c0f1d;--cyan:#00f5d4;--pink:#ff2a85;--gold:#fee440;--text:#e2f1ff;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:"JetBrains Mono",monospace;padding:20px;line-height:1.5}
  .wrap{max-width:960px;margin:0 auto}
  header{display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid var(--cyan);padding-bottom:12px;margin-bottom:20px}
  h1{font-size:20px;color:var(--cyan);text-shadow:0 0 10px rgba(0,245,212,.5)}
  .badge{padding:4px 10px;border-radius:4px;font-size:12px;font-weight:bold;background:rgba(0,245,212,.15);color:var(--cyan);border:1px solid var(--cyan)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
  .card{background:var(--card);border:1px solid rgba(0,245,212,.25);border-radius:6px;padding:14px}
  .card .lbl{font-size:11px;color:#8fa6cb;display:block}
  .card .val{font-size:20px;font-weight:bold;color:var(--gold);margin-top:4px;display:block}
  .panel{background:var(--card);border:1px solid rgba(155,93,229,.35);border-radius:6px;padding:16px;margin-bottom:18px}
  .panel h2{font-size:14px;color:var(--cyan);margin-bottom:10px}
  .btn-row{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
  button{background:rgba(0,245,212,.12);color:var(--cyan);border:1px solid var(--cyan);padding:8px 14px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px}
  button:hover{background:var(--cyan);color:#05060c;font-weight:bold}
  pre{background:#04050a;padding:10px;border-radius:4px;overflow-x:auto;font-size:12px;color:#a8ffef;border:1px solid rgba(255,255,255,.08);margin-top:10px}
  table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.07)}
  th{color:#8fa6cb}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>NEON PIXEL // STAGE TELEMETRY CONSOLE v2.0</h1>
    <span class="badge" id="statusBadge">SYNCING...</span>
  </header>
  <div class="grid">
    <div class="card"><span class="lbl">SELF-CHECK</span><span class="val" id="vSelf">--</span></div>
    <div class="card"><span class="lbl">EDGE SYNC</span><span class="val" id="vEdge">--</span></div>
    <div class="card"><span class="lbl">ACTIVE / TOTAL CHANNELS</span><span class="val" id="vChan">0 / 0</span></div>
    <div class="card"><span class="lbl">TRAFFIC (UP / DOWN)</span><span class="val" id="vTraffic">0B / 0B</span></div>
    <div class="card"><span class="lbl">UPTIME / RSS</span><span class="val" id="vSys">0s / 0MB</span></div>
  </div>
  <div class="panel">
    <h2>⚡ 客户端配置导出中心 (Client Profile Export)</h2>
    <div class="btn-row">
      <button id="btnCopySub">复制统一配置地址 (/api/v1/profile/&lt;UUID&gt;)</button>
      <button id="btnLoadSub">预览当前配置内容</button>
    </div>
    <pre id="rawBox">唯一配置地址：基于客户端 User-Agent 自动分发 Base64 或 YAML 配置</pre>
  </div>
  <div class="panel">
    <h2>🛡 近期自愈与监控告警 (Recent Alerts)</h2>
    <table>
      <thead><tr><th>时间</th><th>级别</th><th>模块</th><th>详情</th></tr></thead>
      <tbody id="alertBody"><tr><td colspan="4">暂无异常告警</td></tr></tbody>
    </table>
  </div>
</div>
<script>
(() => {
  const uid = ${JSON.stringify(safeId)};
  const base = location.origin + '/api/v1/profile/' + uid;
  const rawBox = document.getElementById('rawBox');
  rawBox.textContent = '唯一配置入口: ' + base;
  document.getElementById('btnCopySub').onclick = async () => {
    await navigator.clipboard.writeText(base);
    rawBox.textContent = '已复制唯一配置 URL: ' + base;
  };
  document.getElementById('btnLoadSub').onclick = async () => {
    const r = await fetch(base);
    const txt = (await r.text()).trim();
    try {
      rawBox.textContent = atob(txt).trim();
    } catch {
      rawBox.textContent = txt;
    }
  };
  function fmtB(n){const u=['B','KB','MB','GB','TB'];let i=0;while(n>=1024&&i<4){n/=1024;i++;}return n.toFixed(i?1:0)+u[i];}
  async function tick(){
    try {
      const r = await fetch('/api/v1/metrics/' + uid + '?detail=1', { cache: 'no-store' });
      const d = await r.json();
      document.getElementById('statusBadge').textContent = d.draining ? 'DRAINING' : 'ONLINE';
      document.getElementById('vSelf').textContent = d.selfCheck && d.selfCheck.ok ? 'HEALTHY' : 'WARN';
      document.getElementById('vEdge').textContent = d.edge ? (d.edge.ready ? 'READY (' + d.edge.protocol + ' · ' + (d.edge.haConnections || 1) + 'x)' : 'SYNCING') : 'LOCAL';
      document.getElementById('vChan').textContent = d.activeChannels + ' / ' + d.totalChannels;
      document.getElementById('vTraffic').textContent = fmtB(d.bytesUp) + ' / ' + fmtB(d.bytesDown);
      document.getElementById('vSys').textContent = d.uptimeSec + 's / ' + d.rssMB + 'MB';
      const tb = document.getElementById('alertBody');
      if (d.recentAlerts && d.recentAlerts.length) {
        tb.innerHTML = d.recentAlerts.slice().reverse().map(a =>
          '<tr><td>' + a.ts.slice(11,19) + '</td><td>' + a.level + '</td><td>' + a.component + '</td><td>' + a.message + '</td></tr>'
        ).join('');
      }
    } catch {}
  }
  tick();
  setInterval(tick, 3000);
})();
</script>
</body>
</html>`;
}

if (CFG.statsIntervalMs > 0) {
  setInterval(() => {
    const x = snapshot();
    log('info', `stats: 活跃=${x.activeChannels} 会话=${x.sessions} 累计=${x.totalChannels} 上行=${fmtBytes(x.bytesUp)} 下行=${fmtBytes(x.bytesDown)} 鉴权失败=${x.authFailures} 封禁中=${x.banned} 告警=${x.alertsTotal} 内存=${x.rssMB}MB`);
  }, CFG.statsIntervalMs).unref();
}

module.exports = { snapshot, prometheusMetrics, renderAdminHtml };
