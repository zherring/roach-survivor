import {
  CONTAINER_WIDTH, CONTAINER_HEIGHT, ROACH_WIDTH, ROACH_HEIGHT,
  BOOT_WIDTH, BOOT_HEIGHT, BOT_WIDTH, BOT_HEIGHT,
  PLAYER_BASE_SPEED, WEALTH_SPEED_PENALTY_MAX, WEALTH_SPEED_PENALTY_RATE,
  MIN_SPEED, TICK_RATE, MOTEL_SIZE, MOTEL_SAVE_TIME, GRID_SIZE,
  HEAL_COST, MAX_HP,
} from '/shared/constants.js';

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

// Input
const keys = { w: false, a: false, s: false, d: false };
let mouseX = 0, mouseY = 0, mouseInContainer = false;
let bootTilt = 0, prevMouseX = 0;

// DOM refs
const container = document.getElementById('game-container');
const boot = document.getElementById('boot');
const playerArrow = document.getElementById('player-arrow');
const motelEl = document.getElementById('roach-motel');
const timerCountdown = document.getElementById('timer-countdown');
const timerRoom = document.getElementById('timer-room');
const timerEl = document.getElementById('motel-timer');
const statusEl = document.getElementById('connection-status');
const balanceEl = document.getElementById('balance');

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
      currentRoom = msg.room;
      gridSize = msg.gridSize || GRID_SIZE;
      buildMinimap();
      applySnapshot(msg.snapshot);
      motelData = msg.motel;
      log(`<span style="color:#0ff">You are ${myName}!</span>`);
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
      log(`Crawled to room ${msg.room}`);
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
    }
  }

  // Update UI
  updateUI();
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'stomp_kill':
      if (evt.stomperId === myId) {
        kills++;
        log(`<span class="kill">KILLED roach!</span> <span class="money">+$${evt.reward.toFixed(2)}</span>`);
        showCoinShower(evt.x, evt.y, evt.reward);
      }
      showSplat(evt.x, evt.y);
      break;
    case 'stomp_hit':
      if (evt.victimId === myId) {
        log(`<span class="death">You got stomped! (${evt.hp}/2 HP)</span>`);
      }
      break;
    case 'stomp_miss':
      break;
    case 'bot_stomp':
      triggerBotStomp(evt.botId);
      break;
    case 'bot_kill':
      if (evt.victimId === myId) {
        log(`<span class="death">HOUSE BOT killed your roach! Lost $${evt.lost.toFixed(2)}</span>`);
        lastAliveReset = Date.now();
        aliveTime = 0;
      }
      showSplat(evt.x, evt.y);
      break;
    case 'bot_hit':
      if (evt.victimId === myId) {
        log(`<span class="death">House bot hit you! (${evt.hp}/2 HP)</span>`);
      }
      break;
    case 'player_death':
      if (evt.victimId === myId) {
        log(`<span class="death">YOU DIED! Lost $${evt.lost.toFixed(2)}</span>`);
        lastAliveReset = Date.now();
        aliveTime = 0;
      } else if (evt.killerId === myId) {
        log(`<span class="kill">You killed a player!</span>`);
      }
      break;
    case 'bank':
      if (evt.playerId === myId) {
        log(`<span style="color:#f0c040">BANKED $${evt.amount.toFixed(2)}! Total: $${evt.totalBanked.toFixed(2)}</span>`);
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
      nameEl.textContent = data.id === myId ? `(you) ${data.name}` : data.name;
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
    entry = { el, data, prevX: data.x, prevY: data.y, prevTime: Date.now() };
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
    entry.el.style.left = (drawX - BOT_WIDTH / 2) + 'px';
    entry.el.style.top = (drawY - BOT_HEIGHT / 2) + 'px';
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
  } else {
    timerEl.classList.remove('active');
    timerCountdown.textContent = '--';
    timerRoom.innerHTML = 'Spawning soon...';
    timerRoom.classList.remove('here');
    motelEl.classList.add('hidden');
  }
}

// ==================== UI ====================
function updateUI() {
  aliveTime = (Date.now() - lastAliveReset) / 1000;
  document.getElementById('balance').textContent = balance.toFixed(2);
  document.getElementById('banked').textContent = bankedBalance.toFixed(2);
  document.getElementById('alive-time').textContent = Math.floor(aliveTime) + 's';
  document.getElementById('kills').textContent = kills;
  document.getElementById('current-room').textContent = currentRoom;

  const myRoachData = roachEls.get(myId)?.data;
  if (myRoachData) {
    document.getElementById('player-hp').textContent = myRoachData.hp;
  }

  // Heal button
  const healBtn = document.getElementById('heal-btn');
  healBtn.disabled = !myRoachData || myRoachData.hp >= MAX_HP || balance < HEAL_COST;

  // Minimap
  document.querySelectorAll('.room-cell').forEach(cell => {
    cell.classList.toggle('active', cell.dataset.room === currentRoom);
  });

  // Player count
  let playerCount = 0;
  for (const [, entry] of roachEls) {
    if (entry.data.isPlayer) playerCount++;
  }
  document.getElementById('player-count').textContent = `Players in room: ${playerCount}`;
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

function pulseBalance() {
  balanceEl.classList.remove('collecting');
  void balanceEl.offsetWidth;
  balanceEl.classList.add('collecting');
  setTimeout(() => balanceEl.classList.remove('collecting'), 360);
}

function flyToBalance(startX, startY, text, opts = {}) {
  const targetRect = balanceEl.getBoundingClientRect();
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
  const flyStartX = containerRect.left + x;
  const flyStartY = containerRect.top + y;
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
}

// ==================== INPUT ====================
document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k in keys) keys[k] = true;
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
  mouseX = e.clientX - rect.left;
  mouseY = e.clientY - rect.top;

  const dx = mouseX - prevMouseX;
  bootTilt = Math.abs(dx) > 1 ? Math.max(-25, Math.min(25, dx * 3)) : bootTilt * 0.9;
  prevMouseX = mouseX;

  boot.style.left = mouseX + 'px';
  boot.style.top = mouseY + 'px';
  boot.style.transform = `translateX(-50%) translateY(-80%) rotate(${bootTilt}deg)`;
});

container.addEventListener('click', (e) => {
  const rect = container.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  // Optimistic boot animation + impact effects
  boot.classList.remove('stomping');
  void boot.offsetWidth;
  boot.classList.add('stomping');
  showShockwave(x, y - BOOT_HEIGHT * 0.3);
  shakeScreen();

  send({ type: 'stomp', x, y, seq: inputSeq });
});

document.getElementById('heal-btn').addEventListener('click', () => {
  send({ type: 'heal' });
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
      keys: { ...keys },
      x: predictedX,
      y: predictedY,
      vx: predictedVx,
      vy: predictedVy,
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
