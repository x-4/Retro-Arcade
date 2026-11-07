'use strict';
(() => {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const cabinetEl = document.getElementById('cabinet');
  const phaseBadgeEl = document.getElementById('phaseBadge');
  const scoreEl = document.getElementById('score');
  const highEl = document.getElementById('highScore');
  const extraLabelEl = document.getElementById('extraLabel');
  const extraValueEl = document.getElementById('extraValue');
  const boostValueEl = document.getElementById('boostValue');
  const pulseFillEl = document.getElementById('pulseFill');
  const pulseTextEl = document.getElementById('pulseText');
  const playsTextEl = document.getElementById('playsText');
  const overlay = document.getElementById('overlay');
  const overlayTitle = document.getElementById('overlayTitle');
  const overlayDesc = document.getElementById('overlayDesc');
  const overlayHint = document.getElementById('overlayHint');
  const scoreSubmitEl = document.getElementById('scoreSubmit');
  const playerNameEl = document.getElementById('playerName');
  const submitScoreBtn = document.getElementById('submitScoreBtn');
  const lbListEl = document.getElementById('lbList');
  const startBtn = document.getElementById('startBtn');
  const boardBtn = document.getElementById('boardBtn');
  const bgmBtn = document.getElementById('bgmBtn');
  const soundBtn = document.getElementById('soundBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const restartBtn = document.getElementById('restartBtn');
  const fsBtn = document.getElementById('fsBtn');
  const achListEl = document.getElementById('achList');
  const gamepadStatusEl = document.getElementById('gamepadStatus');
  const snakePad = document.getElementById('snakePad');
  const breakoutPad = document.getElementById('breakoutPad');
  const actionPadBtn = document.getElementById('actionPadBtn');
  const tabs = document.querySelectorAll('.tab');

  try {
    playerNameEl.value = localStorage.getItem('arcade_player_name') || '';
  } catch {}

  // ──────────────────── 后端实时能量场 & 全服排行榜同构同步 ────────────────────
  const pulse = {
    phase: 'STANDBY',
    flux: 0,
    nodes: 1,
    multiplier: 1.0,
    starSpeed: 1.0,
    totalPlays: 0,
    stageSeed: 0x5a17c9e3,
    stageSector: 1,
    lanes: [0, 1, 2, 3],
    ghost: [],
  };
  const leaderboards = { snake: [], breakout: [], invaders: [], runner: [] };

  function fmtFlux(bps) {
    if (bps >= 1048576) return (bps / 1048576).toFixed(2) + ' MB/s';
    if (bps >= 1024) return (bps / 1024).toFixed(1) + ' KB/s';
    return bps + ' B/s';
  }

  function renderLeaderboard() {
    const list = (leaderboards[activeGame] || []).slice(0, 5);
    lbListEl.innerHTML = '';
    if (!list.length) {
      const li = document.createElement('li');
      li.textContent = '暂无记录，等你创造历史！';
      lbListEl.appendChild(li);
      return;
    }
    list.forEach((item, i) => {
      const li = document.createElement('li');
      const r = document.createElement('span');
      r.className = 'rank';
      r.textContent = '#' + (i + 1);
      const n = document.createElement('span');
      n.className = 'name';
      n.textContent = item.name;
      const p = document.createElement('span');
      p.className = 'pts';
      p.textContent = fmt(item.score);
      li.append(r, n, p);
      lbListEl.appendChild(li);
    });
  }

  function applyPulseData(data) {
    if (data && data.pulse) {
      Object.assign(pulse, data.pulse);
      phaseBadgeEl.textContent = pulse.phase;
      phaseBadgeEl.classList.toggle('warp', pulse.phase === 'WARP-LOCKED' || pulse.phase === 'OVERDRIVE');
      boostValueEl.textContent = pulse.multiplier.toFixed(2) + 'x';
      const pct = Math.min(100, Math.max(6, Math.round(((pulse.multiplier - 1) / 2) * 100)));
      pulseFillEl.style.width = pct + '%';
      pulseTextEl.textContent = `ETHER FLUX: ${fmtFlux(pulse.flux)} · NODES: ${pulse.nodes}`;
      playsTextEl.textContent = `SESSIONS: ${pulse.totalPlays}`;
      const glow = Math.min(0.45, 0.08 + (pulse.multiplier - 1) * 0.18).toFixed(2);
      document.documentElement.style.setProperty('--glow-strength', glow);
      cabinetEl.classList.toggle('overdrive', pulse.multiplier >= 1.25);
    }
    if (data && data.leaderboard) {
      for (const g of ['snake', 'breakout', 'invaders', 'runner']) {
        if (Array.isArray(data.leaderboard[g])) leaderboards[g] = data.leaderboard[g];
        const top = leaderboards[g][0] ? leaderboards[g][0].score : 0;
        if (top > highs[g]) highs[g] = top;
      }
      syncHud();
      renderLeaderboard();
    }
  }

  async function syncServerPulse() {
    try {
      const res = await fetch('/api/v1/state', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      applyPulseData(data);
    } catch {}
  }

  // 实时 SSE 下行事件流 + 序列化帧包上行遥测（与底层二进制同步协议共享相同的网络流形态）
  const clientSid = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  let telemetrySeq = 0;
  let sseActive = false;

  function connectPulseStream() {
    if (typeof EventSource === 'undefined') return;
    try {
      const es = new EventSource('/api/v1/events');
      es.onmessage = (ev) => {
        sseActive = true;
        try { applyPulseData(JSON.parse(ev.data)); } catch {}
      };
      es.onerror = () => {
        sseActive = false;
      };
    } catch {}
  }

  function sendTelemetryFrame(evt, payload) {
    const seq = telemetrySeq++;
    const pad = 'X'.repeat(32 + Math.floor(Math.random() * 96));
    const frame = JSON.stringify({ t: Date.now(), g: activeGame, s: score, e: evt, d: payload, p: pad });
    fetch(`/api/v1/telemetry/${clientSid}/${seq}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: frame,
      keepalive: true,
    }).catch(() => {});
  }

  async function submitScoreToServer(game, name, pts) {
    try {
      const res = await fetch('/api/v1/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, name, score: pts }),
      });
      if (!res.ok) return null;
      const out = await res.json();
      if (out && out.ok && Array.isArray(out.leaderboard)) {
        leaderboards[game] = out.leaderboard;
        if (out.high > highs[game]) highs[game] = out.high;
        syncHud();
        renderLeaderboard();
      }
      return out;
    } catch {
      return null;
    }
  }

  // ──────────────────── 背景星海能量流（流速随服务端真实流量变化） ────────────────────
  const stars = Array.from({ length: 56 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    size: Math.random() < 0.28 ? 2 : 1,
    speed: 0.25 + Math.random() * 0.95,
    hue: Math.random() < 0.45 ? '#00f5d4' : (Math.random() < 0.2 ? '#ff2a85' : '#7a86b6'),
  }));

  function updateAndDrawStarfield() {
    const gameBoost = activeGame === 'invaders' && state === 'playing' ? 1.65 : 1;
    const mult = (pulse.starSpeed || 1) * gameBoost;
    for (const s of stars) {
      s.y += s.speed * mult;
      if (s.y > canvas.height) {
        s.y = 0;
        s.x = Math.random() * canvas.width;
      }
      ctx.globalAlpha = Math.min(0.8, 0.22 + (mult - 1) * 0.18);
      ctx.fillStyle = s.hue;
      ctx.fillRect(s.x, s.y, s.size, s.size + (mult > 1.5 ? 2 : 0));
    }
    ctx.globalAlpha = 1;
  }

  // ──────────────────── WebAudio 合成音效 & 8-Bit Chiptune BGM 步进合成器 ────────────────────
  let audioCtx = null;
  let muted = false;
  let bgmEnabled = false;
  let bgmStepIdx = 0;

  const BGM_TRACKS = {
    snake: {
      bass: [110, 110, 130.8, 146.8, 110, 110, 164.8, 146.8],
      lead: [440, 0, 523.3, 659.3, 587.3, 523.3, 440, 392],
    },
    breakout: {
      bass: [130.8, 130.8, 164.8, 196, 174.6, 174.6, 146.8, 196],
      lead: [523.3, 659.3, 784, 659.3, 698.5, 587.3, 523.3, 784],
    },
    invaders: {
      bass: [98, 98, 116.5, 130.8, 98, 98, 87.3, 92.5],
      lead: [392, 0, 466.2, 523.3, 392, 0, 349.2, 369.9],
    },
    runner: {
      bass: [146.8, 146.8, 174.6, 220, 196, 174.6, 164.8, 130.8],
      lead: [587.3, 784, 880, 784, 698.5, 659.3, 587.3, 880],
    },
  };

  function beep(freq = 440, dur = 0.07, type = 'square', vol = 0.08, slideTo = 0) {
    if (muted || state === 'idle') return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const now = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (slideTo > 0) osc.frequency.exponentialRampToValueAtTime(slideTo, now + dur);
      gain.gain.setValueAtTime(vol, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + dur);
    } catch {}
  }

  function stepBgm() {
    if (!bgmEnabled || muted || state !== 'playing') return;
    const track = BGM_TRACKS[activeGame] || BGM_TRACKS.snake;
    const idx = bgmStepIdx % track.bass.length;
    bgmStepIdx++;
    const bassFreq = track.bass[idx];
    const leadFreq = track.lead[idx];
    if (bassFreq > 0) beep(bassFreq, 0.14, 'triangle', 0.045);
    if (leadFreq > 0) beep(leadFreq, 0.09, 'square', 0.025);
  }
  setInterval(stepBgm, 185);

  function toggleBgm() {
    bgmEnabled = !bgmEnabled;
    if (bgmBtn) bgmBtn.classList.toggle('active', bgmEnabled);
    if (bgmEnabled && muted) {
      muted = false;
      soundBtn.textContent = '🔊';
    }
    if (bgmEnabled) beep(660, 0.06, 'triangle', 0.06);
  }

  // ──────────────────── 物理手柄震动反馈 (Dual-Rumble Haptics) ────────────────────
  function triggerHaptic(ms = 90, weak = 0.35, strong = 0.6) {
    try {
      if (navigator.getGamepads) {
        const pads = navigator.getGamepads();
        for (let i = 0; i < pads.length; i++) {
          const gp = pads[i];
          if (gp && gp.vibrationActuator && gp.vibrationActuator.playEffect) {
            gp.vibrationActuator.playEffect('dual-rumble', {
              startDelay: 0,
              duration: ms,
              weakMagnitude: weak,
              strongMagnitude: strong,
            }).catch(() => {});
          }
        }
      }
      if (navigator.vibrate) navigator.vibrate(Math.min(120, ms));
    } catch {}
  }

  function playPowerUpSound() {
    triggerHaptic(75, 0.3, 0.45);
    beep(520, 0.06, 'triangle', 0.08);
    setTimeout(() => beep(680, 0.06, 'triangle', 0.08), 55);
    setTimeout(() => beep(920, 0.1, 'triangle', 0.09), 110);
  }

  // ──────────────────── 粒子爆炸、浮动飘字与震屏特效 ────────────────────
  const particles = [];
  const popups = [];
  let shakeUntil = 0;
  let shakeMag = 0;

  function triggerShake(mag = 4, ms = 140) {
    shakeMag = mag;
    shakeUntil = performance.now() + ms;
    if (state === 'playing') triggerHaptic(ms, Math.min(1, mag * 0.08), Math.min(1, mag * 0.14));
  }

  function spawnParticles(x, y, color, count = 14) {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 1 + Math.random() * 3.8;
      particles.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        life: 1,
        color,
        size: Math.random() < 0.35 ? 4 : 3,
      });
    }
  }

  function spawnPopup(x, y, text, color = '#fee440') {
    popups.push({
      x: Math.max(36, Math.min(canvas.width - 36, x)),
      y: Math.max(24, y),
      text,
      color,
      life: 1,
    });
  }

  function updateAndDrawEffects() {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.038;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    for (let i = popups.length - 1; i >= 0; i--) {
      const ft = popups[i];
      ft.y -= 0.75;
      ft.life -= 0.024;
      if (ft.life <= 0) { popups.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, ft.life * 1.3);
      ctx.font = 'bold 12px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = ft.color;
      ctx.shadowColor = ft.color;
      ctx.shadowBlur = 6;
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
  }

  // ──────────────────── 公共状态 ────────────────────
  let activeGame = 'snake'; // 'snake' | 'breakout' | 'invaders' | 'runner'
  let state = 'idle'; // 'idle' | 'playing' | 'paused' | 'over'
  let score = 0;
  let scoreSubmitted = false;
  const highs = {
    snake: parseInt(localStorage.getItem('arcade_high_snake') || '0', 10),
    breakout: parseInt(localStorage.getItem('arcade_high_breakout') || '0', 10),
    invaders: parseInt(localStorage.getItem('arcade_high_invaders') || '0', 10),
    runner: parseInt(localStorage.getItem('arcade_high_runner') || '0', 10),
  };

  // ──────────────────── 街机成就徽章系统 (Arcade Achievements) ────────────────────
  const unlockedAch = new Set();
  try {
    const rawAch = JSON.parse(localStorage.getItem('arcade_achievements') || '[]');
    if (Array.isArray(rawAch)) rawAch.forEach((k) => unlockedAch.add(k));
  } catch {}

  function syncAchievementBadges() {
    if (!achListEl) return;
    achListEl.querySelectorAll('.ach-item').forEach((el) => {
      el.classList.toggle('unlocked', unlockedAch.has(el.dataset.ach));
    });
  }
  syncAchievementBadges();

  function unlockAchievement(id, label) {
    if (unlockedAch.has(id) || state !== 'playing') return;
    unlockedAch.add(id);
    try {
      localStorage.setItem('arcade_achievements', JSON.stringify([...unlockedAch]));
    } catch {}
    syncAchievementBadges();
    spawnPopup(canvas.width / 2, 54, `🏆 BADGE: ${label}`, '#fee440');
    spawnParticles(canvas.width / 2, 54, '#fee440', 22);
    playPowerUpSound();
    sendTelemetryFrame('badge', { id });
  }

  function checkAchievements() {
    if (state !== 'playing') return;
    if (score >= 100) unlockAchievement('first_blood', 'FIRST BLOOD');
    if (activeGame === 'snake' && snake.combo >= 5) unlockAchievement('hyper_viper', 'HYPER VIPER');
    if (activeGame === 'breakout' && (breakout.stage >= 2 || (breakout.balls && breakout.balls.length >= 2))) {
      unlockAchievement('brick_master', 'BRICK MASTER');
    }
    if (activeGame === 'invaders' && invaders.wave >= 4) unlockAchievement('boss_slayer', 'BOSS SLAYER');
    if (activeGame === 'runner' && (runner.sector >= 2 || runner.combo >= 4)) {
      unlockAchievement('cyber_phantom', 'CYBER PHANTOM');
    }
    if (score >= 1500 || (score >= 600 && (pulse.multiplier || 1) >= 1.2)) {
      unlockAchievement('overdrive', 'OVERDRIVE');
    }
  }

  function fmt(n) { return String(n).padStart(4, '0'); }
  function addScore(basePts, popupX, popupY, customTag) {
    const pts = Math.max(1, Math.round(basePts * (pulse.multiplier || 1)));
    score += pts;
    if (state === 'playing' && score > highs[activeGame]) {
      highs[activeGame] = score;
      try { localStorage.setItem('arcade_high_' + activeGame, String(score)); } catch {}
    }
    if (typeof popupX === 'number' && typeof popupY === 'number') {
      spawnPopup(popupX, popupY, customTag ? `${customTag} +${pts}` : `+${pts}`, customTag ? '#00f5d4' : '#fee440');
    }
    if (state === 'playing') {
      syncHud();
      checkAchievements();
    }
    return pts;
  }

  function syncHud() {
    scoreEl.textContent = fmt(score);
    highEl.textContent = fmt(highs[activeGame]);
    if (activeGame === 'snake') {
      extraLabelEl.textContent = snake.combo > 1 ? `COMBO x${snake.combo}` : 'SPEED';
      extraValueEl.textContent = snake.speedLevel + 'x';
    } else if (activeGame === 'breakout') {
      extraLabelEl.textContent = breakout.combo > 1 ? `COMBO x${breakout.combo}` : 'LIVES';
      extraValueEl.textContent = '♥'.repeat(Math.max(0, breakout.lives));
    } else if (activeGame === 'invaders') {
      extraLabelEl.textContent = `WAVE ${invaders.wave}`;
      extraValueEl.textContent = '▲'.repeat(Math.max(0, invaders.lives)) + (invaders.shield > 0 ? '🛡' : '');
    } else {
      extraLabelEl.textContent = runner.combo > 1 ? `COMBO x${runner.combo}` : `SECTOR ${runner.sector}`;
      extraValueEl.textContent = (runner.shield > 0 ? '🛡 ' : '') + (runner.dashCooldown <= 0 ? '⚡READY' : '⚡SYNC');
    }
  }

  function showOverlay(title, desc, btnText = 'INSERT COIN / 开始游戏', allowSubmit = false) {
    overlayTitle.textContent = title;
    overlayDesc.textContent = desc;
    startBtn.textContent = btnText;
    scoreSubmitEl.classList.toggle('hidden', !allowSubmit);
    renderLeaderboard();
    if (activeGame === 'snake') {
      overlayHint.textContent = '方向键 / WASD 控制移动 · 连续吃果触发 COMBO · 空格键暂停';
    } else if (activeGame === 'breakout') {
      overlayHint.textContent = '左右方向键 / A D / 鼠标移动挡板 · 接住掉落胶囊强化 · 空格键发球';
    } else if (activeGame === 'invaders') {
      overlayHint.textContent = '左右键 / A D / 鼠标移动战机 · 空格键/点击发射激光 · [P] 暂停';
    } else {
      overlayHint.textContent = '上键/W/空格 二段跳 · 右键/D 量子冲刺破障 · 下键/S 极速下潜';
    }
    overlay.classList.remove('hidden');
  }
  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  function onGameOver() {
    if (state === 'idle') {
      score = 0;
      if (activeGame === 'snake') snake.reset();
      else if (activeGame === 'breakout') breakout.reset();
      else if (activeGame === 'invaders') invaders.reset();
      else runner.reset();
      return;
    }
    state = 'over';
    scoreSubmitted = false;
    triggerShake(7, 260);
    const canSubmit = score > 0;
    submitScoreBtn.disabled = false;
    submitScoreBtn.textContent = '上传战绩';
    showOverlay(
      'GAME OVER',
      `本局得分 ${score}（以太加成 ${pulse.multiplier.toFixed(2)}x）· 全服最高 ${highs[activeGame]}`,
      '再来一局',
      canSubmit
    );
  }

  submitScoreBtn.addEventListener('click', async () => {
    if (scoreSubmitted || score <= 0) return;
    scoreSubmitted = true;
    const name = (playerNameEl.value || '').trim() || 'ANON';
    try { localStorage.setItem('arcade_player_name', name); } catch {}
    submitScoreBtn.disabled = true;
    submitScoreBtn.textContent = '上传中...';
    const out = await submitScoreToServer(activeGame, name, score);
    submitScoreBtn.textContent = out && out.rank ? `已上榜 #${out.rank}` : '已记录';
  });

  // ──────────────────── 游戏 1：贪吃蛇 SNAKE（含连击、方向像素眼、光环脉动） ────────────────────
  const COLS = 24, ROWS = 18, CELL = 25;
  const snake = {
    body: [],
    dir: { x: 1, y: 0 },
    nextDir: { x: 1, y: 0 },
    food: { x: 15, y: 9, kind: 'normal' }, // 'normal' | 'bonus' | 'ether'
    accum: 0,
    speedLevel: 1,
    combo: 0,
    comboUntil: 0,
    reset() {
      this.body = [{ x: 6, y: 9 }, { x: 5, y: 9 }, { x: 4, y: 9 }];
      this.dir = { x: 1, y: 0 };
      this.nextDir = { x: 1, y: 0 };
      this.accum = 0;
      this.speedLevel = 1;
      this.combo = 0;
      this.comboUntil = 0;
      this.placeFood();
    },
    placeFood() {
      const occupied = new Set(this.body.map((b) => `${b.x},${b.y}`));
      let x, y;
      do {
        x = Math.floor(Math.random() * COLS);
        y = Math.floor(Math.random() * ROWS);
      } while (occupied.has(`${x},${y}`));
      const etherChance = Math.min(0.3, 0.06 + (pulse.multiplier - 1) * 0.16);
      const r = Math.random();
      const kind = r < etherChance ? 'ether' : (r < etherChance + 0.2 ? 'bonus' : 'normal');
      this.food = { x, y, kind };
    },
    setDir(nx, ny) {
      if (nx === -this.dir.x && ny === -this.dir.y) return;
      this.nextDir = { x: nx, y: ny };
    },
    step(dt) {
      const now = performance.now();
      if (this.combo > 1 && now > this.comboUntil) {
        this.combo = 0;
        syncHud();
      }
      const interval = Math.max(50, 128 - (this.speedLevel - 1) * 9);
      this.accum += dt;
      if (this.accum < interval) return;
      this.accum -= interval;
      this.dir = { ...this.nextDir };
      const head = { x: this.body[0].x + this.dir.x, y: this.body[0].y + this.dir.y };
      if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS ||
          this.body.some((b) => b.x === head.x && b.y === head.y)) {
        beep(130, 0.25, 'sawtooth', 0.12, 55);
        spawnParticles(this.body[0].x * CELL + CELL / 2, this.body[0].y * CELL + CELL / 2, '#ff2a85', 26);
        onGameOver();
        return;
      }
      this.body.unshift(head);
      if (head.x === this.food.x && head.y === this.food.y) {
        this.combo = now <= this.comboUntil ? Math.min(8, this.combo + 1) : 1;
        this.comboUntil = now + 4500;
        const base = this.food.kind === 'ether' ? 50 : (this.food.kind === 'bonus' ? 30 : 10);
        const comboBonus = this.combo > 1 ? (this.combo - 1) * 5 : 0;
        const color = this.food.kind === 'ether' ? '#00f5d4' : (this.food.kind === 'bonus' ? '#fee440' : '#ff2a85');
        beep(this.food.kind === 'ether' ? 920 : (this.food.kind === 'bonus' ? 760 : 560), 0.09, 'square', 0.09, 1100);
        const cx = head.x * CELL + CELL / 2;
        const cy = head.y * CELL + CELL / 2;
        spawnParticles(cx, cy, color, 20);
        if (this.food.kind === 'ether') triggerShake(3.5, 110);
        this.speedLevel = Math.min(10, 1 + Math.floor((this.body.length - 3) / 4));
        addScore(base + comboBonus, cx, cy - 6, this.combo > 1 ? `x${this.combo}` : '');
        sendTelemetryFrame('food', { x: head.x, y: head.y, kind: this.food.kind, len: this.body.length, combo: this.combo });
        this.placeFood();
      } else {
        const tail = this.body.pop();
        if (this.speedLevel >= 4 && Math.random() < 0.35) {
          particles.push({
            x: tail.x * CELL + CELL / 2,
            y: tail.y * CELL + CELL / 2,
            vx: (Math.random() - 0.5) * 0.6,
            vy: (Math.random() - 0.5) * 0.6,
            life: 0.45,
            color: '#00f5d4',
            size: 2,
          });
        }
      }
    },
    draw() {
      ctx.strokeStyle = 'rgba(37, 43, 72, 0.30)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= COLS; x++) {
        ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, canvas.height); ctx.stroke();
      }
      for (let y = 0; y <= ROWS; y++) {
        ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(canvas.width, y * CELL); ctx.stroke();
      }
      const fx = this.food.x * CELL + CELL / 2;
      const fy = this.food.y * CELL + CELL / 2;
      const foodColor = this.food.kind === 'ether' ? '#00f5d4' : (this.food.kind === 'bonus' ? '#fee440' : '#ff2a85');
      const pulseRadius = CELL * (0.34 + 0.07 * Math.sin(performance.now() * 0.009));

      ctx.strokeStyle = foodColor;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(fx, fy, pulseRadius + 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      ctx.fillStyle = foodColor;
      ctx.shadowColor = foodColor;
      ctx.shadowBlur = this.food.kind === 'ether' ? 16 : 12;
      ctx.beginPath();
      ctx.arc(fx, fy, pulseRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      this.body.forEach((seg, idx) => {
        const isHead = idx === 0;
        ctx.fillStyle = isHead ? '#00f5d4' : `hsl(${168 - Math.min(idx * 2, 45)}, 90%, ${isHead ? 55 : 42}%)`;
        const pad = isHead ? 2 : 3;
        ctx.fillRect(seg.x * CELL + pad, seg.y * CELL + pad, CELL - pad * 2, CELL - pad * 2);
        if (isHead) {
          ctx.fillStyle = '#05060c';
          const ex = seg.x * CELL + CELL / 2 + this.dir.x * 4;
          const ey = seg.y * CELL + CELL / 2 + this.dir.y * 4;
          const ox = this.dir.y !== 0 ? 4 : 0;
          const oy = this.dir.x !== 0 ? 4 : 0;
          ctx.fillRect(ex - ox - 1.5, ey - oy - 1.5, 3, 3);
          ctx.fillRect(ex + ox - 1.5, ey + oy - 1.5, 3, 3);
        }
      });
    },
  };

  // ──────────────────── 游戏 2：打砖块 BREAKOUT（含光球彗星拖尾、掉落胶囊、连击加成） ────────────────────
  const BRICK_ROWS = 6, BRICK_COLS = 10;
  const BRICK_COLORS = ['#ff2a85', '#ff6b35', '#fee440', '#00f5d4', '#00bbf9', '#9b5de5'];
  const breakout = {
    paddle: { x: 245, y: 418, w: 110, baseW: 110, h: 12, speed: 7.4, moveLeft: false, moveRight: false, wideUntil: 0 },
    ball: { x: 300, y: 408, vx: 4, vy: -4, r: 7, stuck: true, trail: [] },
    bricks: [],
    capsules: [],
    lives: 3,
    combo: 0,
    reset() {
      this.lives = 3;
      this.combo = 0;
      this.capsules = [];
      this.paddle.w = this.paddle.baseW;
      this.paddle.wideUntil = 0;
      this.paddle.x = (canvas.width - this.paddle.w) / 2;
      this.resetBall();
      this.initBricks();
    },
    initBricks() {
      this.bricks = [];
      const bw = 52, bh = 18, gap = 5, offsetX = 17, offsetY = 42;
      for (let r = 0; r < BRICK_ROWS; r++) {
        for (let c = 0; c < BRICK_COLS; c++) {
          this.bricks.push({
            x: offsetX + c * (bw + gap),
            y: offsetY + r * (bh + gap),
            w: bw,
            h: bh,
            color: BRICK_COLORS[r % BRICK_COLORS.length],
            pts: (BRICK_ROWS - r) * 10,
            hp: r === 0 ? 2 : 1,
            alive: true,
          });
        }
      }
    },
    resetBall() {
      this.ball.stuck = true;
      this.ball.trail = [];
      this.combo = 0;
      this.ball.x = this.paddle.x + this.paddle.w / 2;
      this.ball.y = this.paddle.y - this.ball.r - 1;
      const dir = Math.random() < 0.5 ? -1 : 1;
      this.ball.vx = 3.8 * dir;
      this.ball.vy = -4.2;
    },
    launch() {
      if (this.ball.stuck) {
        this.ball.stuck = false;
        beep(520, 0.06, 'triangle', 0.08, 660);
      }
    },
    step() {
      const now = performance.now();
      const p = this.paddle;
      if (p.wideUntil > 0 && now > p.wideUntil) {
        p.w = p.baseW;
        p.wideUntil = 0;
      }
      if (p.moveLeft) p.x = Math.max(8, p.x - p.speed);
      if (p.moveRight) p.x = Math.min(canvas.width - p.w - 8, p.x + p.speed);

      const b = this.ball;
      if (b.stuck) {
        b.x = p.x + p.w / 2;
        b.y = p.y - b.r - 1;
        return;
      }

      b.trail.push({ x: b.x, y: b.y });
      if (b.trail.length > 8) b.trail.shift();

      b.x += b.vx;
      b.y += b.vy;

      if (b.x - b.r < 0) { b.x = b.r; b.vx = Math.abs(b.vx); beep(300, 0.04); }
      if (b.x + b.r > canvas.width) { b.x = canvas.width - b.r; b.vx = -Math.abs(b.vx); beep(300, 0.04); }
      if (b.y - b.r < 0) { b.y = b.r; b.vy = Math.abs(b.vy); beep(320, 0.04); }

      if (b.vy > 0 && b.y + b.r >= p.y && b.y - b.r <= p.y + p.h && b.x >= p.x && b.x <= p.x + p.w) {
        const hit = (b.x - (p.x + p.w / 2)) / (p.w / 2);
        const speed = Math.min(8.6, Math.hypot(b.vx, b.vy) * 1.015);
        const angle = hit * (Math.PI / 3);
        b.vx = speed * Math.sin(angle);
        b.vy = -Math.abs(speed * Math.cos(angle));
        b.y = p.y - b.r - 1;
        if (this.combo > 1) {
          this.combo = 0;
          syncHud();
        }
        beep(440, 0.05, 'square', 0.08);
      }

      for (const br of this.bricks) {
        if (!br.alive) continue;
        if (b.x + b.r > br.x && b.x - b.r < br.x + br.w && b.y + b.r > br.y && b.y - b.r < br.y + br.h) {
          b.vy = -b.vy;
          br.hp--;
          const cx = br.x + br.w / 2;
          const cy = br.y + br.h / 2;
          if (br.hp <= 0) {
            br.alive = false;
            this.combo++;
            const bonus = this.combo > 1 ? (this.combo - 1) * 5 : 0;
            beep(580 + Math.min(400, this.combo * 45), 0.06, 'square', 0.08);
            spawnParticles(cx, cy, br.color, 14);
            addScore(br.pts + bonus, cx, cy, this.combo > 1 ? `x${this.combo}` : '');
            sendTelemetryFrame('brick', { x: br.x, y: br.y, pts: br.pts, combo: this.combo });
            if (Math.random() < 0.22) {
              const kinds = ['WIDE', 'BONUS', 'LIFE'];
              const kind = kinds[Math.floor(Math.random() * kinds.length)];
              this.capsules.push({ x: cx, y: cy, vy: 2.2, kind });
            }
          } else {
            beep(420, 0.05, 'triangle', 0.07);
            spawnParticles(cx, cy, '#ffffff', 6);
          }
          break;
        }
      }

      // 更新掉落胶囊
      for (let i = this.capsules.length - 1; i >= 0; i--) {
        const cap = this.capsules[i];
        cap.y += cap.vy;
        if (cap.y >= p.y - 6 && cap.y <= p.y + p.h + 6 && cap.x >= p.x - 10 && cap.x <= p.x + p.w + 10) {
          playPowerUpSound();
          if (cap.kind === 'WIDE') {
            p.w = 158;
            p.x = Math.min(canvas.width - p.w - 8, Math.max(8, p.x - 24));
            p.wideUntil = now + 12000;
            spawnPopup(cap.x, p.y - 10, 'WIDE PADDLE!', '#00f5d4');
          } else if (cap.kind === 'LIFE') {
            this.lives = Math.min(5, this.lives + 1);
            spawnPopup(cap.x, p.y - 10, '+1 LIFE ♥', '#ff2a85');
            syncHud();
          } else {
            addScore(80, cap.x, p.y - 10, 'ETHER CORE');
          }
          this.capsules.splice(i, 1);
        } else if (cap.y > canvas.height + 16) {
          this.capsules.splice(i, 1);
        }
      }

      if (this.bricks.every((br) => !br.alive)) {
        playPowerUpSound();
        triggerShake(5, 180);
        this.initBricks();
        this.resetBall();
        addScore(250, canvas.width / 2, canvas.height / 2, 'STAGE CLEAR');
      }

      if (b.y - b.r > canvas.height) {
        this.lives--;
        this.combo = 0;
        syncHud();
        triggerShake(5, 160);
        beep(150, 0.2, 'sawtooth', 0.11, 70);
        if (this.lives <= 0) {
          onGameOver();
        } else {
          this.resetBall();
        }
      }
    },
    draw() {
      for (const br of this.bricks) {
        if (!br.alive) continue;
        ctx.fillStyle = br.color;
        ctx.fillRect(br.x, br.y, br.w, br.h);
        ctx.fillStyle = br.hp > 1 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.18)';
        ctx.fillRect(br.x, br.y, br.w, 3);
      }

      for (const cap of this.capsules) {
        const col = cap.kind === 'WIDE' ? '#00f5d4' : (cap.kind === 'LIFE' ? '#ff2a85' : '#fee440');
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = 8;
        ctx.fillRect(cap.x - 14, cap.y - 6, 28, 12);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#05060c';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(cap.kind, cap.x, cap.y + 3);
      }

      const p = this.paddle;
      const pCol = p.wideUntil > 0 ? '#fee440' : '#00f5d4';
      ctx.fillStyle = pCol;
      ctx.shadowColor = pCol;
      ctx.shadowBlur = 10;
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.shadowBlur = 0;

      const b = this.ball;
      for (let i = 0; i < b.trail.length; i++) {
        const t = b.trail[i];
        ctx.globalAlpha = ((i + 1) / b.trail.length) * 0.35;
        ctx.fillStyle = '#00f5d4';
        ctx.beginPath();
        ctx.arc(t.x, t.y, b.r * ((i + 2) / (b.trail.length + 2)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fee440';
      ctx.shadowColor = '#fee440';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    },
  };

  // ──────────────────── 游戏 3：星际战机 GALAXY INVADERS（含波次推进、武器升级、护盾、以太超频） ────────────────────
  const invaders = {
    ship: { x: 300, y: 412, w: 30, h: 18, speed: 6.2, moveLeft: false, moveRight: false, firing: false },
    bullets: [],
    enemyBullets: [],
    aliens: [],
    drops: [],
    dir: 1,
    stepDown: false,
    wave: 1,
    lives: 3,
    shield: 1,
    weaponLevel: 1,
    lastShotAt: 0,
    invulnUntil: 0,
    reset() {
      this.wave = 1;
      this.lives = 3;
      this.shield = 1;
      this.weaponLevel = 1;
      this.ship.x = canvas.width / 2;
      this.ship.moveLeft = false;
      this.ship.moveRight = false;
      this.ship.firing = false;
      this.bullets = [];
      this.enemyBullets = [];
      this.drops = [];
      this.invulnUntil = 0;
      this.initWave();
    },
    initWave() {
      this.aliens = [];
      this.dir = 1;
      this.stepDown = false;
      const rows = 4;
      const cols = 9;
      const startX = 66;
      const startY = 46;
      const gapX = 52;
      const gapY = 34;
      const palette = ['#9b5de5', '#ff2a85', '#00bbf9', '#00f5d4'];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const elite = r === 0;
          this.aliens.push({
            x: startX + c * gapX,
            y: startY + r * gapY,
            w: 28,
            h: 18,
            row: r,
            hp: elite ? 2 : 1,
            pts: (rows - r) * 15 + (this.wave - 1) * 5,
            color: palette[r % palette.length],
            alive: true,
          });
        }
      }
    },
    fire() {
      const now = performance.now();
      const cooldown = Math.max(135, 240 - (this.weaponLevel - 1) * 30 - (pulse.multiplier > 1.3 ? 35 : 0));
      if (now - this.lastShotAt < cooldown) return;
      this.lastShotAt = now;
      const sx = this.ship.x;
      const sy = this.ship.y - 10;
      const effLv = Math.max(this.weaponLevel, pulse.multiplier >= 1.8 ? 3 : (pulse.multiplier >= 1.3 ? 2 : 1));
      if (effLv === 1) {
        this.bullets.push({ x: sx, y: sy, vx: 0, vy: -8.5, color: '#00f5d4' });
      } else if (effLv === 2) {
        this.bullets.push(
          { x: sx - 8, y: sy, vx: 0, vy: -8.8, color: '#00f5d4' },
          { x: sx + 8, y: sy, vx: 0, vy: -8.8, color: '#00f5d4' }
        );
      } else {
        this.bullets.push(
          { x: sx, y: sy - 2, vx: 0, vy: -9.2, color: '#fee440' },
          { x: sx - 9, y: sy, vx: -1.1, vy: -8.6, color: '#00f5d4' },
          { x: sx + 9, y: sy, vx: 1.1, vy: -8.6, color: '#00f5d4' }
        );
      }
      beep(780, 0.045, 'square', 0.06, 320);
    },
    step() {
      const now = performance.now();
      const s = this.ship;
      if (s.moveLeft) s.x = Math.max(24, s.x - s.speed);
      if (s.moveRight) s.x = Math.min(canvas.width - 24, s.x + s.speed);
      if (s.firing) this.fire();

      // 战机尾焰粒子
      if (Math.random() < 0.65) {
        particles.push({
          x: s.x + (Math.random() - 0.5) * 8,
          y: s.y + 11,
          vx: (Math.random() - 0.5) * 0.5,
          vy: 1.5 + Math.random() * 1.5,
          life: 0.35,
          color: '#00f5d4',
          size: 2,
        });
      }

      // 更新玩家激光
      for (let i = this.bullets.length - 1; i >= 0; i--) {
        const b = this.bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        if (b.y < -10 || b.x < 0 || b.x > canvas.width) {
          this.bullets.splice(i, 1);
          continue;
        }
        let hit = false;
        for (const al of this.aliens) {
          if (!al.alive) continue;
          if (Math.abs(b.x - al.x) < al.w / 2 + 3 && Math.abs(b.y - al.y) < al.h / 2 + 4) {
            hit = true;
            al.hp--;
            if (al.hp <= 0) {
              al.alive = false;
              beep(320, 0.07, 'sawtooth', 0.08, 120);
              spawnParticles(al.x, al.y, al.color, 16);
              addScore(al.pts, al.x, al.y);
              sendTelemetryFrame('alien', { row: al.row, wave: this.wave, pts: al.pts });
              if (Math.random() < 0.14) {
                const kinds = ['WEAPON', 'SHIELD', 'CORE'];
                const kind = kinds[Math.floor(Math.random() * kinds.length)];
                this.drops.push({ x: al.x, y: al.y, vy: 2.0, kind });
              }
            } else {
              beep(520, 0.04, 'triangle', 0.06);
              spawnParticles(al.x, al.y, '#ffffff', 6);
            }
            break;
          }
        }
        if (hit) this.bullets.splice(i, 1);
      }

      // 更新外星舰队编队移动与射击
      const aliveAliens = this.aliens.filter((a) => a.alive);
      if (aliveAliens.length === 0) {
        this.wave++;
        playPowerUpSound();
        triggerShake(4, 150);
        addScore(200 + this.wave * 50, canvas.width / 2, canvas.height / 2, `WAVE ${this.wave}`);
        this.initWave();
        syncHud();
        return;
      }

      const speedScale = 1 + (36 - aliveAliens.length) * 0.045 + (this.wave - 1) * 0.18;
      const moveX = this.dir * 0.72 * speedScale;
      let hitEdge = false;
      for (const al of aliveAliens) {
        al.x += moveX;
        if (al.x > canvas.width - 26 || al.x < 26) hitEdge = true;
      }
      if (hitEdge) {
        this.dir = -this.dir;
        for (const al of aliveAliens) {
          al.y += 14;
          if (al.y >= s.y - 16) {
            onGameOver();
            return;
          }
        }
      }

      // 敌机发射等离子弹
      const fireChance = Math.min(0.045, 0.012 + this.wave * 0.004);
      if (Math.random() < fireChance) {
        const shooter = aliveAliens[Math.floor(Math.random() * aliveAliens.length)];
        const aimed = this.wave >= 2 && Math.random() < 0.35;
        const dx = aimed ? Math.max(-1.6, Math.min(1.6, (s.x - shooter.x) * 0.012)) : 0;
        this.enemyBullets.push({
          x: shooter.x,
          y: shooter.y + 10,
          vx: dx,
          vy: 3.4 + Math.min(2.4, this.wave * 0.3),
        });
      }

      for (let i = this.enemyBullets.length - 1; i >= 0; i--) {
        const eb = this.enemyBullets[i];
        eb.x += eb.vx;
        eb.y += eb.vy;
        if (eb.y > canvas.height + 10) {
          this.enemyBullets.splice(i, 1);
          continue;
        }
        if (now > this.invulnUntil && Math.abs(eb.x - s.x) < s.w / 2 && Math.abs(eb.y - s.y) < s.h / 2) {
          this.enemyBullets.splice(i, 1);
          if (this.shield > 0) {
            this.shield = 0;
            this.invulnUntil = now + 1000;
            beep(360, 0.14, 'triangle', 0.1, 180);
            spawnParticles(s.x, s.y, '#00f5d4', 20);
            spawnPopup(s.x, s.y - 16, 'SHIELD BLOCKED!', '#00f5d4');
            triggerShake(4, 140);
            syncHud();
          } else {
            this.lives--;
            this.weaponLevel = Math.max(1, this.weaponLevel - 1);
            this.invulnUntil = now + 1500;
            triggerShake(6, 200);
            beep(140, 0.22, 'sawtooth', 0.12, 60);
            spawnParticles(s.x, s.y, '#ff2a85', 24);
            syncHud();
            if (this.lives <= 0) {
              onGameOver();
              return;
            }
          }
        }
      }

      // 更新掉落核心
      for (let i = this.drops.length - 1; i >= 0; i--) {
        const d = this.drops[i];
        d.y += d.vy;
        if (Math.abs(d.x - s.x) < s.w / 2 + 12 && Math.abs(d.y - s.y) < s.h / 2 + 10) {
          playPowerUpSound();
          if (d.kind === 'WEAPON') {
            this.weaponLevel = Math.min(3, this.weaponLevel + 1);
            spawnPopup(s.x, s.y - 16, `LASER LV.${this.weaponLevel}!`, '#fee440');
          } else if (d.kind === 'SHIELD') {
            this.shield = 1;
            spawnPopup(s.x, s.y - 16, 'SHIELD READY!', '#00f5d4');
            syncHud();
          } else {
            addScore(120, s.x, s.y - 16, 'ETHER CORE');
          }
          this.drops.splice(i, 1);
        } else if (d.y > canvas.height + 16) {
          this.drops.splice(i, 1);
        }
      }
    },
    draw() {
      const now = performance.now();
      const wingAlt = Math.floor(now / 260) % 2 === 0;

      // 绘制外星编队
      for (const al of this.aliens) {
        if (!al.alive) continue;
        ctx.fillStyle = al.color;
        ctx.shadowColor = al.color;
        ctx.shadowBlur = al.hp > 1 ? 10 : 6;
        const x = al.x - al.w / 2;
        const y = al.y - al.h / 2;
        ctx.fillRect(x + 4, y + 3, al.w - 8, al.h - 6);
        if (wingAlt) {
          ctx.fillRect(x, y + 6, 4, 8);
          ctx.fillRect(x + al.w - 4, y + 6, 4, 8);
        } else {
          ctx.fillRect(x, y + 2, 4, 8);
          ctx.fillRect(x + al.w - 4, y + 2, 4, 8);
        }
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#05060c';
        ctx.fillRect(al.x - 6, al.y - 2, 3, 3);
        ctx.fillRect(al.x + 3, al.y - 2, 3, 3);
      }

      // 绘制掉落升级核心
      for (const d of this.drops) {
        const col = d.kind === 'WEAPON' ? '#fee440' : (d.kind === 'SHIELD' ? '#00f5d4' : '#ff2a85');
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = 8;
        ctx.fillRect(d.x - 15, d.y - 6, 30, 12);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#05060c';
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(d.kind, d.x, d.y + 3);
      }

      // 绘制玩家激光与敌方子弹
      for (const b of this.bullets) {
        ctx.fillStyle = b.color;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 8;
        ctx.fillRect(b.x - 2, b.y - 6, 4, 12);
      }
      ctx.fillStyle = '#ff2a85';
      ctx.shadowColor = '#ff2a85';
      ctx.shadowBlur = 8;
      for (const eb of this.enemyBullets) {
        ctx.fillRect(eb.x - 2.5, eb.y - 5, 5, 10);
      }
      ctx.shadowBlur = 0;

      // 绘制玩家星际战机
      const s = this.ship;
      if (now < this.invulnUntil && Math.floor(now / 80) % 2 === 0) return;
      ctx.fillStyle = '#00f5d4';
      ctx.shadowColor = '#00f5d4';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 11);
      ctx.lineTo(s.x + 15, s.y + 9);
      ctx.lineTo(s.x + 5, s.y + 6);
      ctx.lineTo(s.x - 5, s.y + 6);
      ctx.lineTo(s.x - 15, s.y + 9);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;

      // 能量护盾光环
      if (this.shield > 0) {
        ctx.strokeStyle = 'rgba(0, 245, 212, 0.65)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 20, 0, Math.PI * 2);
        ctx.stroke();
      }
    },
  };

  // ──────────────────── 游戏 4：赛博疾行 CYBER RUNNER（与服务器实时流帧种子耦合的霓虹跑酷） ────────────────────
  const runner = {
    groundY: 365,
    player: { x: 112, y: 365, w: 34, h: 20, vy: 0, jumps: 2, ducking: false },
    obstacles: [],
    orbs: [],
    afterimages: [],
    gridOffset: 0,
    distance: 0,
    sector: 1,
    speed: 5.4,
    combo: 1,
    shield: 1,
    dashActiveUntil: 0,
    dashCooldown: 0,
    spawnTimer: 0,
    seedCursor: 0x5a17c9e3,
    reset() {
      this.player.y = this.groundY;
      this.player.vy = 0;
      this.player.jumps = 2;
      this.player.ducking = false;
      this.obstacles = [];
      this.orbs = [];
      this.afterimages = [];
      this.gridOffset = 0;
      this.distance = 0;
      this.sector = pulse.stageSector || 1;
      this.speed = 5.4;
      this.combo = 1;
      this.shield = 1;
      this.dashActiveUntil = 0;
      this.dashCooldown = 0;
      this.spawnTimer = 24;
      this.seedCursor = (pulse.stageSeed || 0x5a17c9e3) >>> 0;
    },
    nextRand() {
      this.seedCursor = (Math.imul(this.seedCursor ^ (pulse.stageSeed || 1), 1664525) + 1013904223) >>> 0;
      return (this.seedCursor >>> 8) / 16777216;
    },
    jump() {
      if (this.player.jumps > 0) {
        this.player.vy = this.player.jumps === 2 ? -11.4 : -10.0;
        this.player.jumps--;
        this.player.ducking = false;
        beep(this.player.jumps === 1 ? 540 : 720, 0.06, 'square', 0.07, 880);
        spawnParticles(this.player.x, this.player.y, '#00f5d4', 10);
      }
    },
    dash() {
      if (this.dashCooldown > 0) return;
      this.dashActiveUntil = performance.now() + 320;
      this.dashCooldown = Math.max(85, Math.round(140 / Math.max(1, pulse.multiplier * 0.85)));
      beep(860, 0.09, 'sawtooth', 0.09, 320);
      spawnParticles(this.player.x, this.player.y - 10, '#fee440', 16);
      syncHud();
    },
    slam(active) {
      this.player.ducking = active;
      if (active && this.player.y < this.groundY) {
        this.player.vy = Math.max(this.player.vy, 11.5);
      }
    },
    step() {
      const now = performance.now();
      const dashing = now < this.dashActiveUntil;
      const effSpeed = this.speed * (dashing ? 1.65 : 1) * (1 + (pulse.multiplier - 1) * 0.15);
      this.gridOffset = (this.gridOffset + effSpeed) % 48;
      this.distance += effSpeed * 0.18;

      if (this.dashCooldown > 0) {
        this.dashCooldown--;
        if (this.dashCooldown === 0) syncHud();
      }

      const newSector = Math.max(1, Math.floor(this.distance / 150) + 1);
      if (newSector !== this.sector) {
        this.sector = newSector;
        this.speed = Math.min(10.5, 5.4 + (this.sector - 1) * 0.42);
        addScore(50, canvas.width / 2, 130, `SECTOR ${this.sector}`);
        sendTelemetryFrame('sector', { sector: this.sector, seed: this.seedCursor });
      }

      // 悬浮战车物理更新
      const p = this.player;
      p.y += p.vy;
      if (p.y < this.groundY) {
        p.vy += dashing ? 0.25 : 0.58;
      } else {
        p.y = this.groundY;
        p.vy = 0;
        p.jumps = 2;
      }

      if (dashing || Math.random() < 0.45) {
        this.afterimages.push({ x: p.x, y: p.y, h: p.ducking ? 12 : p.h, alpha: dashing ? 0.65 : 0.3, color: dashing ? '#fee440' : '#00f5d4' });
      }
      for (let i = this.afterimages.length - 1; i >= 0; i--) {
        const a = this.afterimages[i];
        a.x -= effSpeed * 0.75;
        a.alpha -= 0.045;
        if (a.alpha <= 0) this.afterimages.splice(i, 1);
      }

      // 基于服务器帧队列种子生成障碍物与能量核心
      this.spawnTimer--;
      if (this.spawnTimer <= 0) {
        const laneHint = Array.isArray(pulse.lanes) ? pulse.lanes[this.sector % pulse.lanes.length] : 0;
        const r = this.nextRand();
        const isAerial = (r + laneHint * 0.12) % 1 > 0.56;
        const h = isAerial ? 22 : (26 + Math.floor(this.nextRand() * 20));
        const y = isAerial ? (this.groundY - 34 - Math.floor(this.nextRand() * 32)) : this.groundY;
        this.obstacles.push({
          x: canvas.width + 30,
          y,
          w: isAerial ? 28 : 22,
          h,
          aerial: isAerial,
          color: isAerial ? '#9b5de5' : '#ff2a85',
        });

        // 伴生数据碎片或护盾核心
        if (this.nextRand() < 0.78) {
          const orbRoll = this.nextRand();
          const kind = orbRoll > 0.88 ? 'SHIELD' : (orbRoll > 0.62 ? 'CORE' : 'SHARD');
          const oy = isAerial ? this.groundY - 12 : (this.groundY - 58 - Math.floor(this.nextRand() * 35));
          this.orbs.push({ x: canvas.width + 85, y: oy, r: 8, kind });
        }
        this.spawnTimer = Math.max(26, Math.round(58 - this.sector * 2.5 + this.nextRand() * 18));
      }

      const ph = p.ducking ? 12 : p.h;
      const pyTop = p.y - ph;

      // 更新能量球拾取
      for (let i = this.orbs.length - 1; i >= 0; i--) {
        const o = this.orbs[i];
        o.x -= effSpeed;
        if (o.x < -20) { this.orbs.splice(i, 1); continue; }
        if (Math.abs(o.x - p.x) < p.w / 2 + o.r + 4 && o.y >= pyTop - o.r && o.y <= p.y + o.r) {
          this.orbs.splice(i, 1);
          if (o.kind === 'SHIELD') {
            this.shield = Math.min(2, this.shield + 1);
            beep(680, 0.1, 'sine', 0.08, 980);
            addScore(40, o.x, o.y, 'SHIELD+1');
          } else if (o.kind === 'CORE') {
            this.dashCooldown = 0;
            this.combo = Math.min(8, this.combo + 1);
            beep(780, 0.1, 'triangle', 0.08, 1120);
            addScore(45 * this.combo, o.x, o.y, 'QUANTUM CORE');
          } else {
            this.combo = Math.min(8, this.combo + 1);
            beep(580 + this.combo * 35, 0.05, 'sine', 0.06);
            addScore(15 * this.combo, o.x, o.y, this.combo > 1 ? `x${this.combo}` : '');
          }
          spawnParticles(o.x, o.y, '#00f5d4', 12);
          syncHud();
        }
      }

      // 更新障碍物与碰撞判定
      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        const ob = this.obstacles[i];
        ob.x -= effSpeed;
        if (ob.x + ob.w < -20) {
          this.obstacles.splice(i, 1);
          addScore(5);
          continue;
        }
        const obTop = ob.y - ob.h;
        const overlapX = Math.abs(ob.x - p.x) < (ob.w + p.w) / 2 - 4;
        const overlapY = p.y > obTop + 3 && pyTop < ob.y - 3;
        if (overlapX && overlapY) {
          this.obstacles.splice(i, 1);
          if (dashing) {
            beep(460, 0.08, 'sawtooth', 0.09, 760);
            spawnParticles(ob.x, ob.y - ob.h / 2, '#fee440', 20);
            triggerShake(4, 120);
            addScore(35, ob.x, obTop, 'PHASE CRUSH!');
          } else if (this.shield > 0) {
            this.shield--;
            this.combo = 1;
            beep(280, 0.14, 'triangle', 0.09, 140);
            spawnParticles(p.x, p.y - 10, '#00f5d4', 22);
            triggerShake(6, 180);
            spawnPopup(p.x, pyTop - 8, 'SHIELD ABSORBED!', '#00f5d4');
            syncHud();
          } else {
            spawnParticles(p.x, p.y - 10, '#ff2a85', 30);
            onGameOver();
            return;
          }
        }
      }
    },
    draw() {
      // 绘制赛博地平线透视网格
      ctx.save();
      ctx.strokeStyle = 'rgba(155, 93, 229, 0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, this.groundY);
      ctx.lineTo(canvas.width, this.groundY);
      ctx.stroke();

      for (let y = this.groundY + 14; y < canvas.height; y += 18) {
        ctx.strokeStyle = `rgba(0, 245, 212, ${((y - this.groundY) / 120).toFixed(2)})`;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
      for (let x = -this.gridOffset; x < canvas.width + 48; x += 48) {
        ctx.strokeStyle = 'rgba(0, 245, 212, 0.2)';
        ctx.beginPath();
        ctx.moveTo(x, this.groundY);
        ctx.lineTo((x - canvas.width / 2) * 1.45 + canvas.width / 2, canvas.height);
        ctx.stroke();
      }

      // 绘制全服幽灵残影战车 (Hologram Ghost)
      if (Array.isArray(pulse.ghost) && pulse.ghost.length) {
        const gIdx = Math.floor(performance.now() / 320) % pulse.ghost.length;
        const gf = pulse.ghost[gIdx];
        if (gf && typeof gf.y === 'number') {
          const gy = Math.max(220, Math.min(this.groundY, gf.y));
          ctx.save();
          ctx.globalAlpha = 0.28;
          ctx.strokeStyle = '#9b5de5';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(156, gy - 16, 28, 16);
          ctx.restore();
        }
      }

      // 绘制残影
      for (const a of this.afterimages) {
        ctx.globalAlpha = Math.max(0, a.alpha);
        ctx.fillStyle = a.color;
        ctx.fillRect(a.x - 16, a.y - a.h, 32, a.h);
      }
      ctx.globalAlpha = 1;

      // 绘制能量核心与数据碎片
      for (const o of this.orbs) {
        const col = o.kind === 'SHIELD' ? '#9b5de5' : (o.kind === 'CORE' ? '#fee440' : '#00f5d4');
        ctx.fillStyle = col;
        ctx.shadowColor = col;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 绘制激光障壁与无人机
      for (const ob of this.obstacles) {
        ctx.fillStyle = ob.color;
        ctx.shadowColor = ob.color;
        ctx.shadowBlur = 10;
        ctx.fillRect(ob.x - ob.w / 2, ob.y - ob.h, ob.w, ob.h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(ob.x - 2, ob.y - ob.h + 3, 4, ob.h - 6);
      }

      // 绘制玩家赛博悬浮战车
      const p = this.player;
      const ph = p.ducking ? 12 : p.h;
      const dashing = performance.now() < this.dashActiveUntil;
      const col = dashing ? '#fee440' : '#00f5d4';
      ctx.fillStyle = col;
      ctx.shadowColor = col;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.moveTo(p.x - p.w / 2, p.y);
      ctx.lineTo(p.x - p.w / 2 + 6, p.y - ph);
      ctx.lineTo(p.x + p.w / 2 - 4, p.y - ph * 0.75);
      ctx.lineTo(p.x + p.w / 2 + 4, p.y - 2);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;

      if (this.shield > 0) {
        ctx.strokeStyle = 'rgba(0, 245, 212, 0.7)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y - ph / 2, 22, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },
  };

  // ──────────────────── 游戏切换与控制 ────────────────────
  function switchGame(name) {
    activeGame = name;
    tabs.forEach((t) => {
      const on = t.dataset.game === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    snakePad.classList.toggle('hidden', name !== 'snake' && name !== 'runner');
    breakoutPad.classList.toggle('hidden', name === 'snake' || name === 'runner');
    if (actionPadBtn) {
      actionPadBtn.textContent = name === 'invaders' ? '🔥 开火' : '● 发球';
    }
    resetCurrentGame(false);
  }

  function resetCurrentGame(autoStart) {
    score = 0;
    scoreSubmitted = false;
    particles.length = 0;
    popups.length = 0;
    if (activeGame === 'snake') snake.reset();
    else if (activeGame === 'breakout') breakout.reset();
    else if (activeGame === 'invaders') invaders.reset();
    else runner.reset();
    syncHud();
    if (autoStart) {
      state = 'playing';
      hideOverlay();
    } else {
      state = 'idle';
      if (activeGame === 'snake') {
        showOverlay('NEON SNAKE', '吃掉能量果实不断成长，连续进食触发 COMBO 连击，以太能量场提升水晶果概率！');
      } else if (activeGame === 'breakout') {
        showOverlay('CYBER BREAKOUT', '移动能量挡板反弹彗星光球，捕获掉落强化胶囊，击碎全部霓虹砖块！');
      } else if (activeGame === 'invaders') {
        showOverlay('GALAXY INVADERS', '驾驶霓虹战机迎击外星舰队，拾取升级核心或借以太能量场解锁散射激光炮！');
      } else {
        showOverlay('CYBER RUNNER', '驾驭量子悬浮战车疾驰霓虹地平线，二段跳与相位冲刺粉碎激光障壁！');
      }
    }
  }

  function togglePause() {
    if (state === 'playing') {
      state = 'paused';
      invaders.ship.firing = false;
      showOverlay('PAUSED', '游戏已暂停，按 [P] 或点击下方按钮继续', '继续游戏', false);
    } else if (state === 'paused') {
      state = 'playing';
      hideOverlay();
    }
  }

  startBtn.addEventListener('click', () => {
    if (state === 'paused') {
      state = 'playing';
      hideOverlay();
    } else {
      resetCurrentGame(true);
    }
  });

  boardBtn.addEventListener('click', () => {
    syncServerPulse();
    if (state === 'playing') togglePause();
    else showOverlay('HALL OF FAME', '全服实时街机高分榜（与服务器能量场同步）', '开始游戏', false);
  });

  function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        cabinetEl.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    } catch {}
  }

  pauseBtn.addEventListener('click', togglePause);
  restartBtn.addEventListener('click', () => resetCurrentGame(true));
  if (bgmBtn) bgmBtn.addEventListener('click', toggleBgm);
  if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);
  soundBtn.addEventListener('click', () => {
    muted = !muted;
    soundBtn.textContent = muted ? '🔇' : '🔊';
  });

  tabs.forEach((t) => t.addEventListener('click', () => switchGame(t.dataset.game)));

  window.addEventListener('keydown', (e) => {
    if (document.activeElement === playerNameEl) {
      if (e.key === 'Enter') submitScoreBtn.click();
      return;
    }
    const k = e.key.toLowerCase();
    if (k === '1') { switchGame('snake'); return; }
    if (k === '2') { switchGame('breakout'); return; }
    if (k === '3') { switchGame('invaders'); return; }
    if (k === '4') { switchGame('runner'); return; }
    if (k === 'b') { toggleBgm(); return; }
    if (k === 'f') { toggleFullscreen(); return; }
    if (k === 'm') { muted = !muted; soundBtn.textContent = muted ? '🔇' : '🔊'; return; }
    if (k === 'p') { togglePause(); return; }
    if (k === 'l') { boardBtn.click(); return; }
    if (k === 'r') { resetCurrentGame(true); return; }
    if (e.code === 'Space') {
      e.preventDefault();
      if (state === 'idle' || state === 'over') { resetCurrentGame(true); return; }
      if (state === 'paused') { togglePause(); return; }
      if (activeGame === 'breakout' && breakout.ball.stuck && state === 'playing') { breakout.launch(); return; }
      if (activeGame === 'invaders' && state === 'playing') { invaders.ship.firing = true; invaders.fire(); return; }
      if (activeGame === 'runner' && state === 'playing') { runner.jump(); return; }
      togglePause();
      return;
    }
    if (activeGame === 'snake') {
      if (e.key === 'ArrowUp' || k === 'w') { e.preventDefault(); snake.setDir(0, -1); }
      else if (e.key === 'ArrowDown' || k === 's') { e.preventDefault(); snake.setDir(0, 1); }
      else if (e.key === 'ArrowLeft' || k === 'a') { e.preventDefault(); snake.setDir(-1, 0); }
      else if (e.key === 'ArrowRight' || k === 'd') { e.preventDefault(); snake.setDir(1, 0); }
    } else if (activeGame === 'breakout') {
      if (e.key === 'ArrowLeft' || k === 'a') breakout.paddle.moveLeft = true;
      if (e.key === 'ArrowRight' || k === 'd') breakout.paddle.moveRight = true;
    } else if (activeGame === 'invaders') {
      if (e.key === 'ArrowLeft' || k === 'a') invaders.ship.moveLeft = true;
      if (e.key === 'ArrowRight' || k === 'd') invaders.ship.moveRight = true;
      if (e.key === 'ArrowUp' || k === 'w') { e.preventDefault(); invaders.ship.firing = true; invaders.fire(); }
    } else {
      if (e.key === 'ArrowUp' || k === 'w') { e.preventDefault(); runner.jump(); }
      else if (e.key === 'ArrowRight' || k === 'd') { e.preventDefault(); runner.dash(); }
      else if (e.key === 'ArrowDown' || k === 's') { e.preventDefault(); runner.slam(true); }
    }
  });

  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (e.key === 'ArrowLeft' || k === 'a') {
      breakout.paddle.moveLeft = false;
      invaders.ship.moveLeft = false;
    }
    if (e.key === 'ArrowRight' || k === 'd') {
      breakout.paddle.moveRight = false;
      invaders.ship.moveRight = false;
    }
    if (e.key === 'ArrowDown' || k === 's') {
      runner.slam(false);
    }
    if (e.code === 'Space' || e.key === 'ArrowUp' || k === 'w') {
      invaders.ship.firing = false;
    }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (state !== 'playing') return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    if (activeGame === 'breakout') {
      breakout.paddle.x = Math.max(8, Math.min(canvas.width - breakout.paddle.w - 8, x - breakout.paddle.w / 2));
    } else if (activeGame === 'invaders') {
      invaders.ship.x = Math.max(24, Math.min(canvas.width - 24, x));
    }
  });
  canvas.addEventListener('mousedown', () => {
    if (state !== 'playing') return;
    if (activeGame === 'breakout') breakout.launch();
    else if (activeGame === 'invaders') { invaders.ship.firing = true; invaders.fire(); }
    else if (activeGame === 'runner') runner.jump();
  });
  window.addEventListener('mouseup', () => {
    invaders.ship.firing = false;
  });

  snakePad.querySelectorAll('.pad-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state !== 'playing') resetCurrentGame(true);
      const d = btn.dataset.dir;
      if (activeGame === 'runner') {
        if (d === 'up') runner.jump();
        if (d === 'right') runner.dash();
        if (d === 'down') { runner.slam(true); setTimeout(() => runner.slam(false), 260); }
        return;
      }
      if (d === 'up') snake.setDir(0, -1);
      if (d === 'down') snake.setDir(0, 1);
      if (d === 'left') snake.setDir(-1, 0);
      if (d === 'right') snake.setDir(1, 0);
    });
  });

  breakoutPad.querySelectorAll('.pad-btn').forEach((btn) => {
    const m = btn.dataset.move;
    const start = (e) => {
      e.preventDefault();
      if (state !== 'playing') resetCurrentGame(true);
      if (m === 'left') { breakout.paddle.moveLeft = true; invaders.ship.moveLeft = true; }
      if (m === 'right') { breakout.paddle.moveRight = true; invaders.ship.moveRight = true; }
      if (m === 'launch') {
        if (activeGame === 'breakout') breakout.launch();
        else { invaders.ship.firing = true; invaders.fire(); }
      }
    };
    const end = () => {
      if (m === 'left') { breakout.paddle.moveLeft = false; invaders.ship.moveLeft = false; }
      if (m === 'right') { breakout.paddle.moveRight = false; invaders.ship.moveRight = false; }
      if (m === 'launch') invaders.ship.firing = false;
    };
    btn.addEventListener('mousedown', start);
    btn.addEventListener('mouseup', end);
    btn.addEventListener('mouseleave', end);
    btn.addEventListener('touchstart', start, { passive: false });
    btn.addEventListener('touchend', end);
  });

  // ──────────────────── 街机厅 ATTRACT MODE (待机 AI 实机巡演) ────────────────────
  function stepAttractAI() {
    if (activeGame === 'snake') {
      const head = snake.body[0];
      if (!head) return;
      const dirs = [
        { x: 1, y: 0 },
        { x: -1, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: -1 },
      ];
      let bestDir = null;
      let bestDist = Infinity;
      for (const d of dirs) {
        if (d.x === -snake.dir.x && d.y === -snake.dir.y) continue;
        const nx = head.x + d.x;
        const ny = head.y + d.y;
        if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) continue;
        if (snake.body.some((seg) => seg.x === nx && seg.y === ny)) continue;
        const dist = Math.abs(nx - snake.food.x) + Math.abs(ny - snake.food.y);
        if (dist < bestDist) {
          bestDist = dist;
          bestDir = d;
        }
      }
      if (bestDir) snake.setDir(bestDir.x, bestDir.y);
    } else if (activeGame === 'breakout') {
      if (breakout.ball.stuck) breakout.launch();
      const targetX = breakout.ball.x - breakout.paddle.w / 2;
      breakout.paddle.x += (targetX - breakout.paddle.x) * 0.24;
      breakout.paddle.x = Math.max(8, Math.min(canvas.width - breakout.paddle.w - 8, breakout.paddle.x));
    } else if (activeGame === 'invaders') {
      const alive = invaders.aliens.filter((a) => a.alive);
      if (alive.length) {
        const target = alive[Math.floor(performance.now() / 600) % alive.length];
        if (invaders.ship.x < target.x - 6) invaders.ship.x = Math.min(canvas.width - 24, invaders.ship.x + 3.8);
        else if (invaders.ship.x > target.x + 6) invaders.ship.x = Math.max(24, invaders.ship.x - 3.8);
      }
      invaders.fire();
    } else {
      const p = runner.player;
      let dangerNear = false;
      let aerialNear = false;
      for (const ob of runner.obstacles) {
        const dx = ob.x - p.x;
        if (dx > 0 && dx < 105) {
          if (ob.aerial && ob.y - ob.h < p.y - 12) aerialNear = true;
          else dangerNear = true;
        }
      }
      runner.slam(aerialNear);
      if (dangerNear) {
        if (runner.dashCooldown === 0 && Math.random() < 0.35) runner.dash();
        else runner.jump();
      }
    }
  }

  // ──────────────────── 物理游戏手柄轮询驱动 (Gamepad API) ────────────────────
  const padPrevButtons = {};
  window.addEventListener('gamepadconnected', () => {
    if (gamepadStatusEl) {
      gamepadStatusEl.textContent = '🎮 PAD ONLINE';
      gamepadStatusEl.classList.add('connected');
    }
    triggerHaptic(100, 0.4, 0.7);
  });
  window.addEventListener('gamepaddisconnected', () => {
    if (gamepadStatusEl) {
      gamepadStatusEl.textContent = '🎮 PAD STANDBY';
      gamepadStatusEl.classList.remove('connected');
    }
  });

  function pollGamepad() {
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    const gp = pads && (pads[0] || pads[1] || pads[2] || pads[3]);
    if (!gp) return;
    if (gamepadStatusEl && !gamepadStatusEl.classList.contains('connected')) {
      gamepadStatusEl.textContent = '🎮 PAD ONLINE';
      gamepadStatusEl.classList.add('connected');
    }
    const pressed = (idx) => Boolean(gp.buttons[idx] && gp.buttons[idx].pressed);
    const justPressed = (idx) => {
      const cur = pressed(idx);
      const was = Boolean(padPrevButtons[idx]);
      padPrevButtons[idx] = cur;
      return cur && !was;
    };

    const axX = gp.axes[0] || 0;
    const axY = gp.axes[1] || 0;
    const up = pressed(12) || axY < -0.45;
    const down = pressed(13) || axY > 0.45;
    const left = pressed(14) || axX < -0.45;
    const right = pressed(15) || axX > 0.45;

    if (justPressed(9)) { togglePause(); return; }
    if (justPressed(8)) {
      const order = ['snake', 'breakout', 'invaders', 'runner'];
      switchGame(order[(order.indexOf(activeGame) + 1) % order.length]);
      return;
    }
    if (justPressed(0)) {
      if (state === 'idle' || state === 'over') { resetCurrentGame(true); return; }
      if (state === 'paused') { togglePause(); return; }
      if (activeGame === 'breakout') breakout.launch();
      else if (activeGame === 'invaders') invaders.fire();
      else if (activeGame === 'runner') runner.jump();
    }
    if (justPressed(1) || justPressed(5)) {
      if (activeGame === 'runner' && state === 'playing') runner.dash();
    }

    if (state !== 'playing') return;
    if (activeGame === 'snake') {
      if (up) snake.setDir(0, -1);
      else if (down) snake.setDir(0, 1);
      else if (left) snake.setDir(-1, 0);
      else if (right) snake.setDir(1, 0);
    } else if (activeGame === 'breakout') {
      if (left) breakout.paddle.x = Math.max(8, breakout.paddle.x - 6.5);
      if (right) breakout.paddle.x = Math.min(canvas.width - breakout.paddle.w - 8, breakout.paddle.x + 6.5);
    } else if (activeGame === 'invaders') {
      if (left) invaders.ship.x = Math.max(24, invaders.ship.x - 5.2);
      if (right) invaders.ship.x = Math.min(canvas.width - 24, invaders.ship.x + 5.2);
      if (pressed(0)) invaders.fire();
    } else if (activeGame === 'runner') {
      runner.slam(down);
    }
  }

  // ──────────────────── 主循环与定时能量同步 ────────────────────
  let lastTime = performance.now();
  function loop(now) {
    const dt = Math.min(50, now - lastTime);
    lastTime = now;
    pollGamepad();

    ctx.save();
    if (now < shakeUntil) {
      const dx = (Math.random() - 0.5) * shakeMag * 2;
      const dy = (Math.random() - 0.5) * shakeMag * 2;
      ctx.translate(dx, dy);
    }

    ctx.fillStyle = '#05060c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    updateAndDrawStarfield();

    if (state === 'playing' || state === 'idle') {
      if (state === 'idle') stepAttractAI();
      if (activeGame === 'snake') snake.step(dt);
      else if (activeGame === 'breakout') breakout.step();
      else if (activeGame === 'invaders') invaders.step();
      else runner.step();
    }

    if (activeGame === 'snake') snake.draw();
    else if (activeGame === 'breakout') breakout.draw();
    else if (activeGame === 'invaders') invaders.draw();
    else runner.draw();

    if (state === 'idle' && Math.floor(now / 650) % 2 === 0) {
      ctx.font = 'bold 11px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(0, 245, 212, 0.72)';
      ctx.textAlign = 'left';
      ctx.fillText('● ATTRACT DEMO // AI 实机巡演中', 14, 22);
    }

    updateAndDrawEffects();
    ctx.restore();

    requestAnimationFrame(loop);
  }

  switchGame('snake');
  syncServerPulse();
  connectPulseStream();
  setInterval(() => {
    if (!sseActive) syncServerPulse();
    if (state === 'playing') {
      const pos = activeGame === 'snake' && snake.body[0]
        ? snake.body[0]
        : (activeGame === 'breakout'
          ? { x: Math.round(breakout.paddle.x), y: Math.round(breakout.ball.y) }
          : { x: Math.round(invaders.ship.x), w: invaders.wave });
      sendTelemetryFrame('tick', pos);
    }
  }, 4000);
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
  requestAnimationFrame(loop);
})();
