import {
  CONTAINER_WIDTH, CONTAINER_HEIGHT, ROACH_WIDTH, ROACH_HEIGHT,
  BOOT_WIDTH, BOOT_HEIGHT, BOT_WIDTH, BOT_HEIGHT,
  PLAYER_BASE_SPEED, WEALTH_SPEED_PENALTY_MAX, WEALTH_SPEED_PENALTY_RATE,
  MIN_SPEED, TICK_RATE, MOTEL_SIZE, MOTEL_SAVE_TIME, GRID_SIZE,
  HEAL_COST, MAX_HP,
} from '/shared/constants.js';

// ==================== AUDIO ====================
const AudioManager = {
  ctx: null,
  buffers: {},
  muted: false,
  loaded: false,
  unlocked: false,

  async init() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const sounds = {
      stomp_kill: 'assets/roachstomp_dead.wav',
      stomp_hit: 'assets/roachstomp_alive.wav',
      player_dead: 'assets/roach_player_dead.wav',
      coin: 'assets/pickupCoin.wav',
      bank: 'assets/bank.wav',
      click: 'assets/click.wav',
      synth: 'assets/synth.wav',
    };
    const entries = Object.entries(sounds);
    await Promise.all(entries.map(async ([key, url]) => {
      try {
        const resp = await fetch(url);
        const buf = await resp.arrayBuffer();
        this.buffers[key] = await this.ctx.decodeAudioData(buf);
      } catch (e) {
        console.warn(`Failed to load sound: ${key}`, e);
      }
    }));
    // Create reversed coin buffer for "losing money" sound
    const coinBuf = this.buffers.coin;
    if (coinBuf) {
      const reversed = this.ctx.createBuffer(coinBuf.numberOfChannels, coinBuf.length, coinBuf.sampleRate);
      for (let ch = 0; ch < coinBuf.numberOfChannels; ch++) {
        const srcData = coinBuf.getChannelData(ch);
        const revData = reversed.getChannelData(ch);
        for (let i = 0; i < srcData.length; i++) {
          revData[i] = srcData[srcData.length - 1 - i];
        }
      }
      this.buffers.coin_rev = reversed;
    }
    this.loaded = true;
  },

  // Mobile browsers require a user gesture to unlock AudioContext
  unlock() {
    if (this.unlocked || !this.ctx) return;
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    this.unlocked = true;
  },

  play(name, volume = 1) {
    if (this.muted || !this.loaded || !this.buffers[name]) return;
    this.unlock();
    const source = this.ctx.createBufferSource();
    source.buffer = this.buffers[name];
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(this.ctx.destination);
    source.start(0);
  },

  // Play coin chime count times staggered
  playCoins(count, volume = 0.5) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => this.play('coin', volume), i * 80);
    }
  },

  // Reversed coin sound — money leaving
  playReversedCoins(count, volume = 0.4) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => this.play('coin_rev', volume), i * 80);
    }
  },

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }
};

AudioManager.init();

// Unlock audio on first user interaction (mobile requirement)
const unlockAudio = () => AudioManager.unlock();
document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('touchstart', unlockAudio, { once: true });

// ==================== STATE ====================
let myId = null;
let myName = '';
let currentRoom = '1,1';
let gridSize = GRID_SIZE;
let balance = 0;
let bankedBalance = 0;
let kills = 0;
let aliveTime = 0;
let lastAliveReset = Date.now();

// Entity maps: id -> { data, el, prevX, prevY, prevTime }
const roachEls = new Map();
const botEls = new Map();
const nameEls = new Map();
const otherBootEls = new Map();

// Prediction state
let inputSeq = 0;
const inputBuffer = []; // { seq, keys } — inputs not yet acknowledged by server
let predictedX = 300;
let predictedY = 200;
let predictedVx = 0;
let predictedVy = 0;
let lastServerSeq = 0;

// Motel
let motelData = null; // { room, x, y, active, despawnTime }
let motelProgress = 0;
let lastCountdownNum = 0;
let savingCountdownEl = null;

// Track successful server-side heals so respawns do not trigger heal VFX
let lastHealCount = 0;

// Input
const keys = { w: false, a: false, s: false, d: false };
let mouseX = 0, mouseY = 0, mouseInContainer = false;
let bootTilt = 0, prevMouseX = 0;

// DOM refs
const container = document.getElementById('game-container');
const wrapper = document.getElementById('game-wrapper');
const boot = document.getElementById('boot');
const healHint = document.getElementById('heal-hint');

// Responsive scaling
let scaleFactor = 1;
function updateScale() {
  const isMobile = window.innerWidth <= 640;
  const availWidth = isMobile ? window.innerWidth : Math.min(document.body.clientWidth - 10, CONTAINER_WIDTH);
  scaleFactor = availWidth / CONTAINER_WIDTH;
  container.style.setProperty('--game-scale', scaleFactor);
  wrapper.style.width = (CONTAINER_WIDTH * scaleFactor) + 'px';
  wrapper.style.height = (CONTAINER_HEIGHT * scaleFactor) + 'px';
}
window.addEventListener('resize', updateScale);
updateScale();
const playerArrow = document.getElementById('player-arrow');
const motelEl = document.getElementById('roach-motel');
const timerCountdown = document.getElementById('timer-countdown');
const timerRoom = document.getElementById('timer-room');
const timerEl = document.getElementById('motel-timer');
const statusEl = document.getElementById('connection-status');
const balanceEl = document.getElementById('balance');
const bankedEl = document.getElementById('banked');
const mobileBalanceEl = document.getElementById('m-balance');
const mobileBankedEl = document.getElementById('m-banked');

function getVisibleStatEl(desktopEl, mobileEl) {
  if (window.innerWidth <= 640 && mobileEl && mobileEl.getClientRects().length > 0) {
    return mobileEl;
  }
  return desktopEl;
}

// ==================== NETWORK ====================
let ws = null;
let connected = false;

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    connected = true;
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';
    log('<span style="color:#0f0">Connected to server!</span>');
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = () => {
    connected = false;
    statusEl.textContent = 'Disconnected — reconnecting...';
    statusEl.className = '';
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {};
}

function send(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

// ==================== MESSAGE HANDLERS ====================
function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.id;
      myName = msg.name;
      lastHealCount = 0;
      currentRoom = msg.room;
      gridSize = msg.gridSize || GRID_SIZE;
      buildMinimap();
      applySnapshot(msg.snapshot);
      motelData = msg.motel;
      log(`<span style="color:#0ff">You are ${escapeHtml(myName)}!</span>`);
      log('Your roach is <span style="color:#0ff">CYAN</span>. <span style="color:#a00">RED BOOTS</span> hunt wealthy roaches.');
      break;

    case 'tick':
      handleTick(msg);
      break;

    case 'room_enter':
      currentRoom = msg.room;
      clearEntities();
      applySnapshot(msg.snapshot);
      motelData = msg.motel;
      AudioManager.play('synth', 0.3);
      log(`Crawled to room ${msg.room}`);
      prospector.onRoomChange(msg.room);
      break;
  }
}

function handleTick(msg) {
  const room = msg.room;

  // Update player stats
  if (msg.you) {
    balance = msg.you.balance;
    bankedBalance = msg.you.banked;
    lastServerSeq = msg.you.lastInputSeq;
    if (Number.isFinite(msg.you.healCount)) {
      if (msg.you.healCount > lastHealCount) {
        showHealEffect();
      }
      lastHealCount = msg.you.healCount;
    }
  }

  // Reconcile prediction
  const myRoach = room.roaches.find(r => r.id === myId);
  if (myRoach) {
    reconcile(myRoach);
  }

  // Update/create roach elements
  const seenRoachIds = new Set();
  for (const r of room.roaches) {
    seenRoachIds.add(r.id);
    updateRoachEl(r);
  }
  // Remove gone roaches
  for (const [id, entry] of roachEls) {
    if (!seenRoachIds.has(id)) {
      entry.el.remove();
      roachEls.delete(id);
      if (nameEls.has(id)) { nameEls.get(id).remove(); nameEls.delete(id); }
    }
  }

  // Update/create bot elements
  const seenBotIds = new Set();
  for (const b of room.bots) {
    seenBotIds.add(b.id);
    updateBotEl(b);
  }
  for (const [id, entry] of botEls) {
    if (!seenBotIds.has(id)) {
      entry.el.remove();
      botEls.delete(id);
    }
  }

  // Motel
  motelData = msg.motel;
  motelProgress = msg.motelProgress || 0;
  updateMotelDisplay();

  // Process events
  if (msg.events) {
    for (const evt of msg.events) {
      handleEvent(evt);
      prospector.onGameEvent(evt);
    }
  }

  // Prospector passive checks — once per second (every 20 ticks at 50ms)
  prospectorTickCount++;
  if (prospectorTickCount >= 20) {
    prospectorTickCount = 0;
    prospector.checkPassive();
  }

  // Update other players' boot cursors
  const seenCursorIds = new Set();
  if (msg.cursors) {
    for (const c of msg.cursors) {
      seenCursorIds.add(c.id);
      let bootEl = otherBootEls.get(c.id);
      if (!bootEl) {
        bootEl = document.createElement('div');
        bootEl.className = 'boot other-boot hovering';
        container.appendChild(bootEl);
        otherBootEls.set(c.id, bootEl);
      }
      bootEl.style.left = c.x + 'px';
      bootEl.style.top = c.y + 'px';
    }
  }
  for (const [cid, el] of otherBootEls) {
    if (!seenCursorIds.has(cid)) {
      el.remove();
      otherBootEls.delete(cid);
    }
  }

  // Update UI
  updateUI();
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'stomp_kill':
      AudioManager.play('stomp_kill', 0.7);
      if (evt.stomperId === myId) {
        kills++;
        log(`<span class="kill">KILLED roach!</span> <span class="money">+$${evt.reward.toFixed(2)}</span>`);
        showCoinShower(evt.x, evt.y, evt.reward);
        const killChimes = Math.max(1, Math.min(5, Math.ceil(evt.reward)));
        AudioManager.playCoins(killChimes, 0.5);
      }
      showSplat(evt.x, evt.y);
      break;
    case 'stomp_hit':
      AudioManager.play('stomp_hit', 0.5);
      if (evt.victimId === myId) {
        log(`<span class="death">You got stomped! (${evt.hp}/${MAX_HP} HP)</span>`);
      }
      break;
    case 'stomp_miss':
      break;
    case 'bot_stomp':
      AudioManager.play('stomp_hit', 0.4);
      triggerBotStomp(evt.botId);
      break;
    case 'bot_kill':
      AudioManager.play('stomp_kill', 0.6);
      if (evt.victimId === myId) {
        log(`<span class="death">HOUSE BOT killed your roach! Lost $${evt.lost.toFixed(2)}</span>`);
        AudioManager.play('player_dead', 0.8);
        AudioManager.playReversedCoins(3, 0.5);
        lastAliveReset = Date.now();
        aliveTime = 0;
      }
      showSplat(evt.x, evt.y);
      break;
    case 'bot_hit':
      AudioManager.play('stomp_hit', 0.4);
      if (evt.victimId === myId) {
        log(`<span class="death">House bot hit you! (${evt.hp}/2 HP)</span>`);
      }
      break;
    case 'player_death':
      if (evt.victimId === myId) {
        log(`<span class="death">YOU DIED! Lost $${evt.lost.toFixed(2)}</span>`);
        AudioManager.play('player_dead', 0.8);
        AudioManager.playReversedCoins(3, 0.5);
        lastAliveReset = Date.now();
        aliveTime = 0;
      } else if (evt.killerId === myId) {
        log(`<span class="kill">You killed a player!</span>`);
        AudioManager.playCoins(5, 0.5);
      }
      break;
    case 'bank':
      if (evt.playerId === myId) {
        log(`<span style="color:#f0c040">BANKED $${evt.amount.toFixed(2)}! Total: $${evt.totalBanked.toFixed(2)}</span>`);
        AudioManager.play('bank', 0.7);
        const bankChimes = Math.max(1, Math.min(5, Math.ceil(evt.amount)));
        AudioManager.playCoins(bankChimes, 0.45);
        showBankEffect(evt.amount, evt.totalBanked);
      }
      break;
    case 'bank_cancel':
      if (evt.playerId === myId) {
        log('<span style="color:#f80">Saving cancelled - stay in the motel!</span>');
      }
      break;
  }
}

// ==================== ENTITY RENDERING ====================
function updateRoachEl(data) {
  let entry = roachEls.get(data.id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'roach';
    container.appendChild(el);
    entry = { el, data, prevX: data.x, prevY: data.y, prevTime: Date.now() };
    roachEls.set(data.id, entry);

    // Name label for players
    if (data.isPlayer && data.name) {
      const nameEl = document.createElement('div');
      nameEl.className = 'roach-name';
      nameEl.textContent = data.id === myId ? `(you) ${data.name || ''}` : (data.name || '');
      container.appendChild(nameEl);
      nameEls.set(data.id, nameEl);
    }
  }

  // Store previous position for interpolation
  entry.prevX = entry.data.x;
  entry.prevY = entry.data.y;
  entry.prevTime = Date.now();
  entry.data = data;

  // CSS classes
  const el = entry.el;
  el.classList.toggle('rich', data.balance > 1);
  el.classList.toggle('dead', data.dead);
  el.classList.toggle('player-self', data.id === myId);
  el.classList.toggle('player-other', data.isPlayer && data.id !== myId);

  // Animate crawling
  const isMoving = Math.abs(data.vx) > 0.1 || Math.abs(data.vy) > 0.1;
  el.classList.toggle('crawling', isMoving && (Date.now() % 200 < 100));

  // Saving state
  el.classList.toggle('saving', data.id === myId && motelProgress > 0);
}

function updateBotEl(data) {
  let entry = botEls.get(data.id);
  if (!entry) {
    const el = document.createElement('div');
    el.className = 'house-bot';
    container.appendChild(el);
    entry = { el, data, prevX: data.x, prevY: data.y, prevTime: Date.now(), lastDrawX: data.x, lastAngle: 0 };
    botEls.set(data.id, entry);
  }
  entry.prevX = entry.data.x;
  entry.prevY = entry.data.y;
  entry.prevTime = Date.now();
  entry.data = data;
}

function clearEntities() {
  for (const [id, entry] of roachEls) { entry.el.remove(); }
  roachEls.clear();
  for (const [id, el] of nameEls) { el.remove(); }
  nameEls.clear();
  for (const [id, entry] of botEls) { entry.el.remove(); }
  botEls.clear();
  for (const [id, el] of otherBootEls) { el.remove(); }
  otherBootEls.clear();
}

function applySnapshot(snapshot) {
  for (const r of snapshot.roaches) {
    updateRoachEl(r);
    if (r.id === myId) {
      predictedX = r.x;
      predictedY = r.y;
      predictedVx = r.vx;
      predictedVy = r.vy;
    }
  }
  for (const b of snapshot.bots) {
    updateBotEl(b);
  }
}

// ==================== PREDICTION ====================
function getSpeed(bal) {
  const penalty = Math.min(bal * WEALTH_SPEED_PENALTY_RATE, WEALTH_SPEED_PENALTY_MAX);
  return Math.max(PLAYER_BASE_SPEED - penalty, MIN_SPEED);
}

function predictFrame() {
  if (!myId) return;

  // Apply WASD forces
  const force = 0.5;
  if (keys.w) predictedVy -= force;
  if (keys.s) predictedVy += force;
  if (keys.a) predictedVx -= force;
  if (keys.d) predictedVx += force;

  // Drunk steering — applied HERE on client so it feels immediate
  predictedVx += (Math.random() - 0.5) * 0.3;
  predictedVy += (Math.random() - 0.5) * 0.3;

  // Clamp speed
  const speed = getSpeed(balance);
  const mag = Math.sqrt(predictedVx * predictedVx + predictedVy * predictedVy);
  if (mag > speed) {
    predictedVx = (predictedVx / mag) * speed;
    predictedVy = (predictedVy / mag) * speed;
  }

  predictedX += predictedVx;
  predictedY += predictedVy;

  // Clamp to room edges (allow slight overflow for transitions)
  predictedX = Math.max(-10, Math.min(CONTAINER_WIDTH + 10, predictedX));
  predictedY = Math.max(-10, Math.min(CONTAINER_HEIGHT + 10, predictedY));
}

function reconcile(serverRoach) {
  // Client owns movement — server only overrides on large corrections
  // (respawn, room transition, or anti-cheat clamp)
  const errX = predictedX - serverRoach.x;
  const errY = predictedY - serverRoach.y;
  const err = Math.sqrt(errX * errX + errY * errY);

  if (err > 50) {
    // Server forced a big move (respawn, transition) — snap to it
    predictedX = serverRoach.x;
    predictedY = serverRoach.y;
    predictedVx = serverRoach.vx;
    predictedVy = serverRoach.vy;
  }
  // Otherwise trust client position entirely
}

// ==================== RENDER LOOP ====================
function render() {
  const now = Date.now();

  for (const [id, entry] of roachEls) {
    let drawX, drawY, vx, vy;

    if (id === myId) {
      // Use predicted position
      drawX = predictedX;
      drawY = predictedY;
      vx = predictedVx;
      vy = predictedVy;
    } else {
      // Interpolate
      const elapsed = now - entry.prevTime;
      const alpha = Math.min(elapsed / TICK_RATE, 1.2); // allow slight extrapolation
      drawX = entry.prevX + (entry.data.x - entry.prevX) * alpha;
      drawY = entry.prevY + (entry.data.y - entry.prevY) * alpha;
      vx = entry.data.vx;
      vy = entry.data.vy;
    }

    const el = entry.el;
    el.style.left = drawX + 'px';
    el.style.top = drawY + 'px';

    // Scale based on wealth
    const wealthScale = 1 + Math.min(entry.data.balance / 25, 2);

    // Rotation from velocity
    const speed = Math.sqrt(vx * vx + vy * vy);
    let rotation = 0;
    if (speed > 0.2) {
      rotation = Math.atan2(vy, vx) * (180 / Math.PI) + 90;
    }
    el.style.transform = `rotate(${rotation}deg) scale(${wealthScale})`;

    // Name label position
    const nameEl = nameEls.get(id);
    if (nameEl) {
      nameEl.style.left = (drawX + ROACH_WIDTH * wealthScale / 2 - 30) + 'px';
      nameEl.style.top = (drawY - 15 - (wealthScale - 1) * 10) + 'px';
    }
  }

  // Player arrow
  if (myId && roachEls.has(myId)) {
    const wealthScale = 1 + Math.min(balance / 25, 2);
    const arrowX = predictedX + (ROACH_WIDTH * wealthScale) / 2 - 8;
    const arrowY = predictedY - 25 - (wealthScale - 1) * 10;
    playerArrow.style.left = arrowX + 'px';
    playerArrow.style.top = arrowY + 'px';
    playerArrow.style.transform = `scale(${Math.max(1.5, wealthScale)})`;
    playerArrow.style.display = '';
  } else {
    playerArrow.style.display = 'none';
  }

  // Bots
  for (const [id, entry] of botEls) {
    const elapsed = now - entry.prevTime;
    const alpha = Math.min(elapsed / TICK_RATE, 1.2);
    const drawX = entry.prevX + (entry.data.x - entry.prevX) * alpha;
    const drawY = entry.prevY + (entry.data.y - entry.prevY) * alpha;
    // Tilt based on horizontal movement
    const botDx = drawX - (entry.lastDrawX ?? drawX);
    if (Math.abs(botDx) > 0.5) {
      entry.lastAngle = Math.max(-20, Math.min(20, botDx * 8));
    }
    entry.lastDrawX = drawX;

    entry.el.style.left = (drawX - BOT_WIDTH / 2) + 'px';
    entry.el.style.top = (drawY - BOT_HEIGHT / 2) + 'px';
    entry.el.style.transform = `rotate(${entry.lastAngle || 0}deg)`;
  }

  // Saving countdown
  if (motelProgress > 0 && myId) {
    const remaining = Math.ceil(MOTEL_SAVE_TIME - motelProgress);
    if (!savingCountdownEl) {
      savingCountdownEl = document.createElement('div');
      savingCountdownEl.className = 'save-countdown';
      container.appendChild(savingCountdownEl);
    }
    savingCountdownEl.style.left = (predictedX + ROACH_WIDTH / 2 - 10) + 'px';
    savingCountdownEl.style.top = (predictedY - 30) + 'px';
    if (remaining !== lastCountdownNum) {
      lastCountdownNum = remaining;
      savingCountdownEl.textContent = remaining;
    }
  } else if (savingCountdownEl) {
    savingCountdownEl.remove();
    savingCountdownEl = null;
    lastCountdownNum = 0;
  }
}

// ==================== MOTEL DISPLAY ====================
function updateMotelDisplay() {
  // Mobile motel info elements
  const mmInfo = document.getElementById('mobile-motel-info');
  const mmCountdown = document.getElementById('mm-motel-countdown');
  const mmRoom = document.getElementById('mm-motel-room');

  if (motelData && motelData.active) {
    timerEl.classList.add('active');
    const remaining = Math.max(0, Math.ceil((motelData.despawnTime - Date.now()) / 1000));
    timerCountdown.textContent = remaining + 's';

    if (motelData.room === currentRoom) {
      timerRoom.innerHTML = '>>> HERE! <<<';
      timerRoom.classList.add('here');
      motelEl.classList.remove('hidden');
      motelEl.style.left = motelData.x + 'px';
      motelEl.style.top = motelData.y + 'px';
    } else {
      timerRoom.innerHTML = 'Room: ' + motelData.room;
      timerRoom.classList.remove('here');
      motelEl.classList.add('hidden');
    }

    // Mobile
    if (mmInfo) {
      mmInfo.classList.remove('inactive');
      mmCountdown.textContent = remaining + 's';
      if (motelData.room === currentRoom) {
        mmRoom.textContent = '>>> HERE! <<<';
        mmRoom.classList.add('here');
      } else {
        mmRoom.textContent = 'Room ' + motelData.room;
        mmRoom.classList.remove('here');
      }
    }
  } else {
    timerEl.classList.remove('active');
    timerCountdown.textContent = '--';
    timerRoom.innerHTML = 'Spawning soon...';
    timerRoom.classList.remove('here');
    motelEl.classList.add('hidden');

    // Mobile
    if (mmInfo) {
      mmInfo.classList.add('inactive');
      mmCountdown.textContent = '--';
      mmRoom.textContent = 'Spawning...';
      mmRoom.classList.remove('here');
    }
  }
}

// ==================== UI ====================
function updateUI() {
  aliveTime = (Date.now() - lastAliveReset) / 1000;
  balanceEl.textContent = balance.toFixed(2);
  bankedEl.textContent = bankedBalance.toFixed(2);
  document.getElementById('alive-time').textContent = Math.floor(aliveTime) + 's';
  document.getElementById('kills').textContent = kills;
  document.getElementById('current-room').textContent = currentRoom;

  const myRoachData = roachEls.get(myId)?.data;
  if (myRoachData) {
    document.getElementById('player-hp').textContent = myRoachData.hp;
  }

  // Heal button
  const healBtn = document.getElementById('heal-btn');
  const healDisabled = !myRoachData || myRoachData.hp >= MAX_HP || balance < HEAL_COST;
  healBtn.disabled = healDisabled;

  // Floating "SPACE TO HEAL" hint
  if (myRoachData && myRoachData.hp < MAX_HP && balance >= HEAL_COST) {
    healHint.classList.add('visible');
    healHint.style.left = (myRoachData.x + ROACH_WIDTH / 2) + 'px';
    healHint.style.top = (myRoachData.y - 12) + 'px';
  } else {
    healHint.classList.remove('visible');
  }

  // Mobile HUD
  const mBalance = document.getElementById('m-balance');
  if (mBalance) {
    mBalance.textContent = balance.toFixed(2);
    if (mobileBankedEl) mobileBankedEl.textContent = bankedBalance.toFixed(2);
    document.getElementById('m-hp').textContent = myRoachData ? `${myRoachData.hp}/${MAX_HP}` : `?/${MAX_HP}`;
    document.getElementById('m-kills').textContent = kills;
    const mHealBtn = document.getElementById('mobile-heal-btn');
    if (mHealBtn) mHealBtn.disabled = healDisabled;
  }

  // Minimap (desktop + mobile)
  const motelRoom = motelData && motelData.active ? motelData.room : null;
  document.querySelectorAll('.room-cell').forEach(cell => {
    cell.classList.toggle('active', cell.dataset.room === currentRoom);
    cell.classList.toggle('motel', cell.dataset.room === motelRoom);
  });
  document.querySelectorAll('.mm-cell').forEach(cell => {
    cell.classList.toggle('active', cell.dataset.room === currentRoom);
    cell.classList.toggle('motel', cell.dataset.room === motelRoom);
  });

  // Player count
  let playerCount = 0;
  for (const [, entry] of roachEls) {
    if (entry.data.isPlayer) playerCount++;
  }
  document.getElementById('player-count').textContent = `Players in room: ${playerCount}`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function log(msg) {
  const logEl = document.getElementById('log');
  logEl.innerHTML = msg + '<br>' + logEl.innerHTML;
  if (logEl.children.length > 50) logEl.removeChild(logEl.lastChild);
}

function triggerBotStomp(botId) {
  const entry = botEls.get(botId);
  if (!entry) return;
  entry.el.classList.remove('stomping');
  void entry.el.offsetWidth;
  entry.el.classList.add('stomping');
  setTimeout(() => entry.el.classList.remove('stomping'), 250);
  // Shockwave + screen shake for bot stomps
  showShockwave(entry.data.x, entry.data.y);
  shakeScreen();
}

function showSplat(x, y) {
  const splat = document.createElement('div');
  splat.className = 'splat';
  splat.style.left = (x - 25) + 'px';
  splat.style.top = (y - 25) + 'px';
  container.appendChild(splat);
  setTimeout(() => splat.remove(), 1200);
}

function showShockwave(x, y) {
  const ring = document.createElement('div');
  ring.className = 'shockwave';
  ring.style.left = x + 'px';
  ring.style.top = y + 'px';
  container.appendChild(ring);
  setTimeout(() => ring.remove(), 400);
}

function shakeScreen() {
  container.classList.remove('shake');
  void container.offsetWidth;
  container.classList.add('shake');
  setTimeout(() => container.classList.remove('shake'), 300);
}

let killCombo = 0;
let comboTimer = null;

function showHealEffect() {
  // Coins fly FROM balance display TO the player roach (reverse of earning)
  const containerRect = container.getBoundingClientRect();
  const sourceBalanceEl = getVisibleStatEl(balanceEl, mobileBalanceEl);
  const balanceRect = sourceBalanceEl.getBoundingClientRect();
  const startX = balanceRect.left + balanceRect.width / 2;
  const startY = balanceRect.top + balanceRect.height / 2;

  const coinCount = 8;
  for (let i = 0; i < coinCount; i++) {
    const targetX = containerRect.left + predictedX * scaleFactor + ROACH_WIDTH / 2 * scaleFactor;
    const targetY = containerRect.top + predictedY * scaleFactor + ROACH_HEIGHT / 2 * scaleFactor;
    const dx = targetX - startX;
    const dy = targetY - startY;
    const midUp = Math.min(-30, dy * 0.3 - 20) + (Math.random() - 0.5) * 30;

    const coin = document.createElement('div');
    coin.className = 'coin hud-fly';
    coin.textContent = '$';
    coin.style.left = startX + 'px';
    coin.style.top = startY + 'px';
    coin.style.color = '#f44';
    coin.style.fontSize = '12px';
    document.body.appendChild(coin);

    const delay = i * 40;
    const anim = coin.animate([
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.4 + (Math.random() - 0.5) * 40}px), calc(-50% + ${midUp}px)) scale(1.1)`, opacity: 1, offset: 0.4 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.5)`, opacity: 0.8, offset: 1 },
    ], { duration: 600, delay, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'forwards' });

    anim.onfinish = () => coin.remove();
  }

  // Pulse balance red (spending)
  sourceBalanceEl.style.color = '#f44';
  setTimeout(() => { sourceBalanceEl.style.color = ''; }, 400);

  // Green heal burst on roach after coins arrive
  AudioManager.playReversedCoins(1, 0.3);
  setTimeout(() => {
    AudioManager.play('synth', 0.4);
    const burst = document.createElement('div');
    burst.className = 'heal-burst';
    burst.style.left = (predictedX + ROACH_WIDTH / 2 - 30) + 'px';
    burst.style.top = (predictedY + ROACH_HEIGHT / 2 - 30) + 'px';
    container.appendChild(burst);
    setTimeout(() => burst.remove(), 600);

    // Pulse HP text green
    const hpEl = document.getElementById('player-hp');
    hpEl.style.color = '#0f0';
    hpEl.style.textShadow = '0 0 8px #0f0';
    hpEl.style.transform = 'scale(1.5)';
    hpEl.style.transition = 'all 0.15s ease-out';
    setTimeout(() => {
      hpEl.style.color = '';
      hpEl.style.textShadow = '';
      hpEl.style.transform = '';
      hpEl.style.transition = 'all 0.3s ease-out';
    }, 300);

    log(`<span style="color:#0f0">Healed! -$${HEAL_COST}</span>`);
  }, 350);
}

function showBankEffect(amount, total) {
  // 1. Gold screen flash
  const flash = document.createElement('div');
  flash.className = 'bank-flash';
  container.appendChild(flash);
  setTimeout(() => flash.remove(), 800);

  // 2. Big "BANKED!" text rising from player
  const banner = document.createElement('div');
  banner.className = 'bank-banner';
  banner.innerHTML = `BANKED!<br><span style="font-size:0.6em">$${amount.toFixed(2)}</span>`;
  banner.style.left = (predictedX + ROACH_WIDTH / 2) + 'px';
  banner.style.top = (predictedY - 20) + 'px';
  container.appendChild(banner);
  setTimeout(() => banner.remove(), 2000);

  // 3. Gold coin explosion — big radial burst from player
  const cx = predictedX + ROACH_WIDTH / 2;
  const cy = predictedY + ROACH_HEIGHT / 2;
  const coinCount = Math.min(50, Math.max(20, Math.ceil(amount * 5)));
  for (let i = 0; i < coinCount; i++) {
    const coin = document.createElement('div');
    coin.className = 'coin big';
    coin.textContent = '$';
    const angle = (i / coinCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const spread = 60 + Math.random() * 100;
    const flyX = Math.cos(angle) * spread;
    const flyY = Math.sin(angle) * spread - 30;
    const dur = 0.8 + Math.random() * 0.6;
    coin.style.left = (cx + (Math.random() - 0.5) * 10) + 'px';
    coin.style.top = (cy + (Math.random() - 0.5) * 10) + 'px';
    coin.style.fontSize = (14 + Math.random() * 10) + 'px';
    coin.style.color = '#ffd700';
    coin.style.setProperty('--fly-x', flyX + 'px');
    coin.style.setProperty('--fly-y', flyY + 'px');
    coin.style.setProperty('--fly-duration', dur + 's');
    coin.style.animationDelay = (i * 0.015) + 's';
    container.appendChild(coin);
    setTimeout(() => coin.remove(), (dur + i * 0.015) * 1000 + 100);
  }

  // 4. Gold shockwave rings (multiple, staggered)
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      const ring = document.createElement('div');
      ring.className = 'bank-ring';
      ring.style.left = cx + 'px';
      ring.style.top = cy + 'px';
      container.appendChild(ring);
      setTimeout(() => ring.remove(), 700);
    }, i * 150);
  }

  // 5. Shake screen (celebratory)
  shakeScreen();

  // 6. Fly coins to banked display
  const containerRect = container.getBoundingClientRect();
  const targetBankedEl = getVisibleStatEl(bankedEl, mobileBankedEl);
  const flyStartX = containerRect.left + cx * scaleFactor;
  const flyStartY = containerRect.top + cy * scaleFactor;
  const flyCount = Math.min(20, Math.max(8, Math.ceil(amount * 3)));
  for (let i = 0; i < flyCount; i++) {
    const targetRect = targetBankedEl.getBoundingClientRect();
    const targetX = targetRect.left + targetRect.width / 2;
    const targetY = targetRect.top + targetRect.height / 2;
    const dx = targetX - flyStartX;
    const dy = targetY - flyStartY;
    const midUp = Math.min(-50, dy * 0.4 - 30) + (Math.random() - 0.5) * 40;

    const el = document.createElement('div');
    el.className = 'coin hud-fly big';
    el.textContent = '$';
    el.style.left = (flyStartX + (Math.random() - 0.5) * 30) + 'px';
    el.style.top = (flyStartY + (Math.random() - 0.5) * 30) + 'px';
    el.style.color = '#ffd700';
    el.style.fontSize = (12 + Math.random() * 6) + 'px';
    document.body.appendChild(el);

    const anim = el.animate([
      { transform: 'translate(-50%, -50%) scale(1.2)', opacity: 1, offset: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.4 + (Math.random() - 0.5) * 50}px), calc(-50% + ${midUp}px)) scale(1)`, opacity: 1, offset: 0.4 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.5)`, opacity: 0.9, offset: 1 },
    ], {
      duration: 900 + Math.random() * 400,
      delay: 300 + i * 30,
      easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
      fill: 'forwards',
    });
    anim.onfinish = () => {
      el.remove();
      if (i === flyCount - 1) {
        // Pulse banked display gold
        targetBankedEl.style.transform = 'scale(1.5)';
        targetBankedEl.style.color = '#fff';
        targetBankedEl.style.textShadow = '0 0 12px #ffd700';
        targetBankedEl.style.transition = 'all 0.15s ease-out';
        setTimeout(() => {
          targetBankedEl.style.transform = '';
          targetBankedEl.style.color = '';
          targetBankedEl.style.textShadow = '';
          targetBankedEl.style.transition = 'all 0.4s ease-out';
        }, 400);
      }
    };
  }

  // 7. Total banked text
  setTimeout(() => {
    const totalEl = document.createElement('div');
    totalEl.className = 'bank-total';
    totalEl.textContent = `Total: $${total.toFixed(2)}`;
    totalEl.style.left = (predictedX + ROACH_WIDTH / 2) + 'px';
    totalEl.style.top = (predictedY - 50) + 'px';
    container.appendChild(totalEl);
    setTimeout(() => totalEl.remove(), 2000);
  }, 600);
}

function pulseBalance() {
  balanceEl.classList.remove('collecting');
  void balanceEl.offsetWidth;
  balanceEl.classList.add('collecting');
  setTimeout(() => balanceEl.classList.remove('collecting'), 360);
}

function flyToBalance(startX, startY, text, opts = {}) {
  const targetBalanceEl = getVisibleStatEl(balanceEl, mobileBalanceEl);
  const targetRect = targetBalanceEl.getBoundingClientRect();
  const targetX = targetRect.left + targetRect.width / 2 + (opts.targetJitterX || 0);
  const targetY = targetRect.top + targetRect.height / 2 + (opts.targetJitterY || 0);
  const dx = targetX - startX;
  const dy = targetY - startY;
  const midUp = Math.min(-45, dy * 0.45 - 30) + (opts.arcJitter || 0);

  const el = document.createElement('div');
  el.className = `coin hud-fly${opts.big ? ' big' : ''}`;
  el.textContent = text;
  el.style.left = startX + 'px';
  el.style.top = startY + 'px';
  if (opts.fontSize) el.style.fontSize = opts.fontSize + 'px';
  if (opts.color) el.style.color = opts.color;
  document.body.appendChild(el);

  const anim = el.animate([
    { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0 },
    { transform: `translate(calc(-50% + ${dx * 0.45}px), calc(-50% + ${midUp}px)) scale(1.05)`, opacity: 1, offset: 0.45 },
    { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.55)`, opacity: 0.9, offset: 1 },
  ], {
    duration: opts.duration || 850,
    delay: opts.delay || 0,
    easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
    fill: 'forwards',
  });

  anim.onfinish = () => {
    el.remove();
    if (opts.onArrive) opts.onArrive();
  };
}

function showCoinShower(x, y, reward) {
  // Track combo — kills within 1.5s multiply the shower
  killCombo++;
  if (comboTimer) clearTimeout(comboTimer);
  comboTimer = setTimeout(() => { killCombo = 0; }, 1500);

  // More coins for bigger rewards and higher combos
  const baseCoinCount = Math.max(3, Math.ceil(reward * 4));
  const coinCount = Math.min(baseCoinCount * killCombo, 40);
  const isBig = killCombo >= 3 || reward > 2;

  for (let i = 0; i < coinCount; i++) {
    const coin = document.createElement('div');
    coin.className = 'coin' + (isBig ? ' big' : '');
    coin.textContent = '$';

    // Random spread
    const angle = (Math.random() * Math.PI * 2);
    const spread = 20 + Math.random() * 40 * killCombo;
    const flyX = Math.cos(angle) * spread;
    const flyY = -30 - Math.random() * 80 - killCombo * 15;
    const duration = 0.6 + Math.random() * 0.6;

    coin.style.left = (x + (Math.random() - 0.5) * 20) + 'px';
    coin.style.top = (y + (Math.random() - 0.5) * 20) + 'px';
    coin.style.fontSize = (10 + Math.random() * 6 + killCombo * 2) + 'px';
    coin.style.setProperty('--fly-x', flyX + 'px');
    coin.style.setProperty('--fly-y', flyY + 'px');
    coin.style.setProperty('--fly-duration', duration + 's');
    coin.style.animationDelay = (i * 0.02) + 's';

    container.appendChild(coin);
    setTimeout(() => coin.remove(), (duration + i * 0.02) * 1000 + 100);
  }

  // Show reward amount floating up
  if (reward > 0.01) {
    const label = document.createElement('div');
    label.className = 'coin big';
    label.textContent = '+$' + reward.toFixed(2);
    label.style.left = (x - 20) + 'px';
    label.style.top = (y - 10) + 'px';
    label.style.fontSize = (14 + killCombo * 3) + 'px';
    label.style.setProperty('--fly-x', '0px');
    label.style.setProperty('--fly-y', '-60px');
    label.style.setProperty('--fly-duration', '1.2s');
    container.appendChild(label);
    setTimeout(() => label.remove(), 1300);
  }

  // Also collect toward the top balance counter.
  const containerRect = container.getBoundingClientRect();
  const flyStartX = containerRect.left + x * scaleFactor;
  const flyStartY = containerRect.top + y * scaleFactor;
  const collectCount = Math.min(16, Math.max(6, Math.ceil(coinCount * 0.45)));

  for (let i = 0; i < collectCount; i++) {
    flyToBalance(
      flyStartX + (Math.random() - 0.5) * 26,
      flyStartY + (Math.random() - 0.5) * 26,
      '$',
      {
        delay: i * 24,
        duration: 700 + Math.random() * 350,
        fontSize: 10 + Math.random() * 8 + killCombo,
        targetJitterX: (Math.random() - 0.5) * 16,
        targetJitterY: (Math.random() - 0.5) * 8,
        arcJitter: (Math.random() - 0.5) * 20,
        onArrive: i === collectCount - 1 ? pulseBalance : null,
      }
    );
  }

  if (reward > 0.01) {
    flyToBalance(flyStartX, flyStartY - 8, '+$' + reward.toFixed(2), {
      big: true,
      delay: 120,
      duration: 1000,
      fontSize: 14 + killCombo * 2,
      targetJitterX: 0,
      targetJitterY: -2,
      arcJitter: -20,
      onArrive: pulseBalance,
    });
  }
}

function buildMinimap() {
  // Desktop minimap
  const grid = document.getElementById('room-grid');
  grid.innerHTML = '';
  grid.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const cell = document.createElement('div');
      cell.className = 'room-cell';
      cell.dataset.room = `${x},${y}`;
      cell.innerHTML = `${x},${y} <span class="bot-indicator"></span><br><div class="wealth-bar"><div class="wealth-fill"></div></div>`;
      grid.appendChild(cell);
    }
  }

  // Mobile minimap
  const mm = document.getElementById('mobile-minimap');
  if (mm) {
    mm.innerHTML = '';
    mm.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const cell = document.createElement('div');
        cell.className = 'mm-cell';
        cell.dataset.room = `${x},${y}`;
        mm.appendChild(cell);
      }
    }
  }
}

// ==================== INPUT ====================
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = true;
  if (e.key === ' ') {
    e.preventDefault();
    send({ type: 'heal' });
  }
});
document.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = false;
});

container.addEventListener('mouseenter', () => {
  mouseInContainer = true;
  boot.classList.add('hovering');
});
container.addEventListener('mouseleave', () => {
  mouseInContainer = false;
  boot.classList.remove('hovering');
});
container.addEventListener('mousemove', (e) => {
  const rect = container.getBoundingClientRect();
  mouseX = (e.clientX - rect.left) / scaleFactor;
  mouseY = (e.clientY - rect.top) / scaleFactor;

  const dx = mouseX - prevMouseX;
  bootTilt = Math.abs(dx) > 1 ? Math.max(-25, Math.min(25, dx * 3)) : bootTilt * 0.9;
  prevMouseX = mouseX;

  boot.style.left = mouseX + 'px';
  boot.style.top = mouseY + 'px';
  boot.style.transform = `translateX(-50%) translateY(-80%) rotate(${bootTilt}deg)`;
});

container.addEventListener('click', (e) => {
  const rect = container.getBoundingClientRect();
  const x = (e.clientX - rect.left) / scaleFactor;
  const y = (e.clientY - rect.top) / scaleFactor;

  // Optimistic boot animation + impact effects
  boot.classList.remove('stomping');
  void boot.offsetWidth;
  boot.classList.add('stomping');
  showShockwave(x, y - BOOT_HEIGHT * 0.3);
  shakeScreen();
  AudioManager.play('click', 0.3);

  send({ type: 'stomp', x, y, seq: inputSeq });
});

document.getElementById('heal-btn').addEventListener('click', () => {
  send({ type: 'heal' });
});
document.getElementById('mobile-heal-btn')?.addEventListener('click', () => {
  send({ type: 'heal' });
});

// ==================== MOBILE TOUCH CONTROLS ====================
const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
const joystickZone = document.getElementById('joystick-zone');
const joystickBase = document.getElementById('joystick-base');
const joystickKnob = document.getElementById('joystick-knob');
const JOYSTICK_RADIUS = 50;
let joystickTouchId = null;

if (isTouchDevice) {
  joystickZone.style.display = 'block';
  const controlsEl = document.getElementById('controls');
  if (controlsEl) {
    controlsEl.innerHTML = '<b>Tap</b> to stomp | <b>Joystick</b> to move | Enter <span style="color:#f0c040">ROACH MOTEL</span> to bank!';
  }
}

// Joystick handlers
joystickZone.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.changedTouches[0];
  joystickTouchId = touch.identifier;
  updateJoystick(touch);
});
joystickZone.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const touch of e.changedTouches) {
    if (touch.identifier === joystickTouchId) updateJoystick(touch);
  }
});
joystickZone.addEventListener('touchend', (e) => {
  for (const touch of e.changedTouches) {
    if (touch.identifier === joystickTouchId) {
      joystickTouchId = null;
      joystickKnob.style.transform = 'translate(-50%, -50%)';
      keys.w = false; keys.a = false; keys.s = false; keys.d = false;
    }
  }
});

function updateJoystick(touch) {
  const rect = joystickBase.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  let dx = touch.clientX - centerX;
  let dy = touch.clientY - centerY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist > JOYSTICK_RADIUS) {
    dx = (dx / dist) * JOYSTICK_RADIUS;
    dy = (dy / dist) * JOYSTICK_RADIUS;
  }
  joystickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
  const deadzone = 15;
  keys.a = dx < -deadzone;
  keys.d = dx > deadzone;
  keys.w = dy < -deadzone;
  keys.s = dy > deadzone;
}

// Tap to stomp (game container touch)
container.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.changedTouches[0];
  const rect = container.getBoundingClientRect();
  const x = (touch.clientX - rect.left) / scaleFactor;
  const y = (touch.clientY - rect.top) / scaleFactor;

  mouseX = x;
  mouseY = y;
  mouseInContainer = true;
  boot.style.left = x + 'px';
  boot.style.top = y + 'px';
  boot.classList.add('hovering');

  boot.classList.remove('stomping');
  void boot.offsetWidth;
  boot.classList.add('stomping');
  showShockwave(x, y - BOOT_HEIGHT * 0.3);
  shakeScreen();
  AudioManager.play('click', 0.3);
  send({ type: 'stomp', x, y, seq: inputSeq });
});
container.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const touch = e.changedTouches[0];
  const rect = container.getBoundingClientRect();
  mouseX = (touch.clientX - rect.left) / scaleFactor;
  mouseY = (touch.clientY - rect.top) / scaleFactor;
  boot.style.left = mouseX + 'px';
  boot.style.top = mouseY + 'px';
});
container.addEventListener('touchend', () => {
  boot.classList.remove('hovering');
  mouseInContainer = false;
});

// ==================== PROSPECTOR NPC ====================
let prospectorTickCount = 0;
const prospector = {
  overlay: document.getElementById('prospector-overlay'),
  faceWrap: document.getElementById('prospector-face-wrap'),
  face: document.getElementById('prospector-face'),
  textEl: document.getElementById('prospector-text'),
  queue: [],
  typing: false,
  visible: false,
  dismissed: false, // "go away!" = permanently gone
  talkTimer: null,
  charIndex: 0,
  currentText: '',
  // Track which events have been seen — each fires ONCE only
  seenEvents: new Set(),

  show(text) {
    if (this.dismissed) return;
    this.currentText = text;
    this.charIndex = 0;
    this.textEl.textContent = '';
    this.visible = true;
    this.overlay.classList.add('visible');
    this.startTalking();
    this.typing = true;
    this._typeNext();
  },

  _typeNext() {
    if (!this.visible) return;
    if (this.charIndex < this.currentText.length) {
      this.charIndex++;
      this.textEl.textContent = this.currentText.slice(0, this.charIndex);
      setTimeout(() => this._typeNext(), 25 + Math.random() * 20);
    } else {
      this.typing = false;
      this.stopTalking();
    }
  },

  startTalking() {
    this.face.src = 'assets/prospector-speaking.png';
    this.faceWrap.classList.add('talking');
    if (this.talkTimer) clearInterval(this.talkTimer);
    let mouthOpen = true;
    this.talkTimer = setInterval(() => {
      mouthOpen = !mouthOpen;
      this.face.src = mouthOpen ? 'assets/prospector-speaking.png' : 'assets/prospector-closed.png';
    }, 120);
  },

  stopTalking() {
    if (this.talkTimer) { clearInterval(this.talkTimer); this.talkTimer = null; }
    this.face.src = 'assets/prospector-closed.png';
    this.faceWrap.classList.remove('talking');
  },

  hide() {
    this.visible = false;
    this.overlay.classList.remove('visible');
    this.stopTalking();
    this.typing = false;
  },

  // "go on..." — skip to next or close
  advance() {
    this.typing = false;
    if (this.queue.length > 0) {
      this.show(this.queue.shift());
    } else {
      this.hide();
    }
  },

  // "go away!" — gone forever
  goAway() {
    this.dismissed = true;
    this.queue = [];
    this.typing = false;
    this.hide();
  },

  say(text) {
    if (this.dismissed) return;
    if (this.visible) {
      this.queue.push(text);
    } else {
      this.show(text);
    }
  },

  // Only fires ONCE per event type, ever
  firstTime(eventType, text) {
    if (this.dismissed || this.seenEvents.has(eventType)) return;
    this.seenEvents.add(eventType);
    this.say(text);
  },

  startOnboarding() {
    const msgs = [
      "Well I'll be! A new roach in these parts! I'm Old Cletus. Use them WASD keys to steer yer roach around.",
      "CLICK to stomp them other roaches and steal their golden bits! Watch out fer them RED BOOTS though.",
      "When the ROACH MOTEL shows up, crawl inside and hold still to BANK yer gold. Now git stompin'!"
    ];
    this.say(msgs[0]);
    for (let i = 1; i < msgs.length; i++) this.queue.push(msgs[i]);
  },

  onGameEvent(evt) {
    if (this.dismissed) return;

    switch (evt.type) {
      case 'stomp_kill':
        if (evt.stomperId === myId) {
          this.firstTime('first_kill', "YEEHAW! Squashed 'im good! That's how we do it in these walls!");
        }
        break;

      case 'stomp_hit':
      case 'bot_hit':
        if (evt.victimId === myId) {
          this.firstTime('first_hit', "OOF! Yer roach took a hit! If yer HP gets low, press SPACE or hit Heal to patch up.");
        }
        break;

      case 'player_death':
      case 'bot_kill':
        if (evt.victimId === myId) {
          this.firstTime('first_death', "Well shoot! Yer roach got flattened! Don't worry, ya respawn - but ya lose most of yer gold!");
        }
        break;

      case 'bank':
        if (evt.playerId === myId) {
          this.firstTime('first_bank', "Smart move bankin' them roach bucks! Banked gold is safe even if ya die.");
        }
        break;
    }
  },

  checkPassive() {
    if (this.dismissed || !myId) return;

    if (motelData && motelData.active && motelData.room === currentRoom) {
      this.firstTime('first_motel_here', "HOT DIGGITY! The Roach Motel's here! Crawl inside and hold still to bank yer gold!");
    }

    if (balance > 8) {
      this.firstTime('first_rich', "Whoa nelly! Yer carryin' a pile of gold! Find that Roach Motel before some boot squashes yer fortune!");
    }
  },

  onRoomChange() {
    this.firstTime('first_room', "New room! Check yer minimap - different rooms got different pickin's.");
  }
};

document.getElementById('btn-go-on').addEventListener('click', () => prospector.advance());
document.getElementById('btn-go-away').addEventListener('click', () => prospector.goAway());
setTimeout(() => prospector.startOnboarding(), 2000);

// ==================== MUTE BUTTON ====================
const muteBtn = document.getElementById('mute-btn');
muteBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const muted = AudioManager.toggleMute();
  muteBtn.textContent = muted ? '✕' : '♪';
  muteBtn.classList.toggle('muted', muted);
});

// ==================== GAME LOOP ====================
let lastInputSend = 0;
let lastKeys = { w: false, a: false, s: false, d: false };

function gameLoop() {
  // Send input if keys changed or every 50ms
  const now = Date.now();
  const keysChanged = keys.w !== lastKeys.w || keys.a !== lastKeys.a || keys.s !== lastKeys.s || keys.d !== lastKeys.d;

  if (connected && myId && (keysChanged || now - lastInputSend > 50)) {
    inputSeq++;
    // Send position + velocity so server can accept client movement directly
    send({
      type: 'input',
      seq: inputSeq,
      x: predictedX,
      y: predictedY,
      vx: predictedVx,
      vy: predictedVy,
      cursorX: mouseInContainer ? mouseX : -1,
      cursorY: mouseInContainer ? mouseY : -1,
    });
    lastKeys = { ...keys };
    lastInputSend = now;
  }

  // Predict
  predictFrame();

  // Render
  render();

  requestAnimationFrame(gameLoop);
}

// ==================== INIT ====================
connect();
gameLoop();
