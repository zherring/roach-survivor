import {
  CONTAINER_WIDTH, CONTAINER_HEIGHT, ROACH_WIDTH, ROACH_HEIGHT,
  BOOT_WIDTH, BOOT_HEIGHT, BOT_WIDTH, BOT_HEIGHT,
  PLAYER_BASE_SPEED, WEALTH_SPEED_PENALTY_MAX, WEALTH_SPEED_PENALTY_RATE,
  MIN_SPEED, TICK_RATE, MOTEL_SIZE, MOTEL_SAVE_TIME, GRID_SIZE,
  HEAL_COST, MAX_HP,
  UPGRADE_DEFS, UPGRADE_ORDER, createDefaultUpgrades, sanitizeUpgrades,
  getUpgradeCost, getBootScale, getMultiStompOffsets, getStompCooldownForLevel,
} from '/shared/constants.js';
import { platform } from './platform.js';

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
let upgrades = createDefaultUpgrades();
let stompCooldownMs = getStompCooldownForLevel(0);
let lastLocalStompAt = 0;

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
const centerPanel = document.getElementById('center-panel');
function updateScale() {
  const isMobile = window.innerWidth <= 640;
  let availWidth;
  if (isMobile) {
    availWidth = window.innerWidth;
  } else {
    // Use center panel's actual width, constrained by aspect ratio to viewport height
    const panelWidth = centerPanel ? centerPanel.clientWidth : CONTAINER_WIDTH;
    const maxHeightScale = (window.innerHeight - 60) / CONTAINER_HEIGHT; // 60px for padding
    availWidth = Math.min(panelWidth, CONTAINER_WIDTH * maxHeightScale);
  }
  scaleFactor = availWidth / CONTAINER_WIDTH;
  container.style.setProperty('--game-scale', scaleFactor);
  wrapper.style.width = (CONTAINER_WIDTH * scaleFactor) + 'px';
  wrapper.style.height = (CONTAINER_HEIGHT * scaleFactor) + 'px';
}
window.addEventListener('resize', () => { updateScale(); resizeMinimapCanvases(); });
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
const shopModal = document.getElementById('shop-modal');
const shopPanelEl = document.getElementById('shop-panel');
const openShopBtn = document.getElementById('open-shop-btn');
const mobileOpenShopBtn = document.getElementById('mobile-open-shop-btn');
const closeShopBtn = document.getElementById('close-shop-btn');
const shopCategoryTabBtns = Array.from(document.querySelectorAll('.shop-category-tab'));
const shopCategoryColumns = Array.from(document.querySelectorAll('.upgrade-column[data-store-tab-content]'));
const shopProspectorFaceEl = document.getElementById('shop-prospector-face');
const shopProspectorTextEl = document.getElementById('shop-prospector-text');
const SHOP_PROSPECTOR_DEFAULT_LINE = "Hover an upgrade and I'll tell ya what it does.";
const SHOP_PROSPECTOR_LINES = {
  bootSize: "This here boot gets wider every level. Bigger sole means more bugs under it.",
  multiStomp: "Extra stomps around the main hit. More little quakes, more squished roaches.",
  rateOfFire: "Speeds up your stompin'. Level it high and that boot comes down like thunder.",
  goldMagnet: "Pure magnet greed. Your roach pulls in way more gold from living and killing.",
  wallBounce: "Turns walls into springboards. Smack the edge and bounce back with force.",
  idleIncome: "Passive drip of money every second. Good for lazy roaches who still want rich pockets.",
  shellArmor: "Thickens your shell. Die less broke by keeping more of what you earned.",
};
const SHOP_PROSPECTOR_TYPE_MS = 500;
let shopProspectorTalkTimer = null;
let shopProspectorMouthTimer = null;
let shopProspectorTypeTimer = null;
let shopProspectorAnimRunId = 0;
let currentStoreTab = 'boot';

function applyUpgradeState(rawUpgrades) {
  upgrades = sanitizeUpgrades(rawUpgrades);
  stompCooldownMs = getStompCooldownForLevel(upgrades.rateOfFire);
  const bootScale = getBootScale(upgrades.bootSize);
  boot.style.setProperty('--boot-scale', bootScale.toFixed(3));
}

function setStompCooldownMs(rawCooldown) {
  const parsed = Number(rawCooldown);
  if (!Number.isFinite(parsed)) return;
  stompCooldownMs = Math.max(30, parsed);
}

function renderUpgradeShop() {
  for (const key of UPGRADE_ORDER) {
    const def = UPGRADE_DEFS[key];
    if (!def) continue;
    const level = upgrades[key] || 0;
    const maxed = level >= def.maxLevel;
    const cost = maxed ? 0 : getUpgradeCost(key, level);
    const canAfford = maxed || (balance + bankedBalance) >= cost;

    const levelEl = document.getElementById(`level-${key}`);
    if (levelEl) {
      levelEl.textContent = `Lv ${level}/${def.maxLevel}`;
    }

    const desktopBtn = document.getElementById(`upgrade-btn-${key}`);
    if (desktopBtn) {
      desktopBtn.disabled = maxed || !canAfford;
      desktopBtn.classList.toggle('maxed', maxed);
      desktopBtn.textContent = maxed ? 'MAXED' : `Buy $${cost.toFixed(2)}`;
    }

  }
}

function tryPurchaseUpgrade(upgradeKey) {
  const def = UPGRADE_DEFS[upgradeKey];
  if (!def) return;
  const level = upgrades[upgradeKey] || 0;
  if (level >= def.maxLevel) return;
  const cost = getUpgradeCost(upgradeKey, level);
  if ((balance + bankedBalance) < cost) return;
  send({ type: 'buy_upgrade', upgrade: upgradeKey });
}

function setShopModalOpen(isOpen) {
  if (!shopModal) return;
  shopModal.classList.toggle('visible', !!isOpen);
  if (isOpen) {
    setShopProspectorLine(null);
    setStoreTab(currentStoreTab, true);
    return;
  }
  shopProspectorAnimRunId++;
  if (shopProspectorTypeTimer) {
    clearTimeout(shopProspectorTypeTimer);
    shopProspectorTypeTimer = null;
  }
  if (shopProspectorTalkTimer) {
    clearTimeout(shopProspectorTalkTimer);
    shopProspectorTalkTimer = null;
  }
  stopShopProspectorTalking();
}

function isStoreTabMode() {
  return window.innerWidth <= 640;
}

function setStoreTab(tabKey, force = false) {
  if (!shopCategoryTabBtns.length || !shopCategoryColumns.length) return;
  const nextTab = tabKey === 'roach' ? 'roach' : 'boot';
  if (!force && nextTab === currentStoreTab) return;
  currentStoreTab = nextTab;
  const tabMode = isStoreTabMode();

  for (const btn of shopCategoryTabBtns) {
    const isActive = btn.dataset.storeTab === currentStoreTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const col of shopCategoryColumns) {
    const isMatch = col.dataset.storeTabContent === currentStoreTab;
    col.classList.toggle('tab-hidden', tabMode && !isMatch);
  }
}

function stopShopProspectorTalking() {
  if (shopProspectorMouthTimer) {
    clearInterval(shopProspectorMouthTimer);
    shopProspectorMouthTimer = null;
  }
  if (shopProspectorFaceEl) {
    shopProspectorFaceEl.src = 'assets/prospector-closed.png';
  }
  const wrap = shopProspectorFaceEl?.parentElement;
  wrap?.classList.remove('talking');
}

function startShopProspectorTalking() {
  const wrap = shopProspectorFaceEl?.parentElement;
  wrap?.classList.add('talking');
  if (!shopProspectorFaceEl) return;
  shopProspectorFaceEl.src = 'assets/prospector-speaking.png';
  if (shopProspectorMouthTimer) clearInterval(shopProspectorMouthTimer);
  let mouthOpen = true;
  shopProspectorMouthTimer = setInterval(() => {
    mouthOpen = !mouthOpen;
    shopProspectorFaceEl.src = mouthOpen ? 'assets/prospector-speaking.png' : 'assets/prospector-closed.png';
  }, 95);
}

function setShopProspectorLine(upgradeKey = null) {
  if (!shopProspectorFaceEl || !shopProspectorTextEl) return;
  const line = SHOP_PROSPECTOR_LINES[upgradeKey] || SHOP_PROSPECTOR_DEFAULT_LINE;
  const runId = ++shopProspectorAnimRunId;

  if (shopProspectorTypeTimer) {
    clearTimeout(shopProspectorTypeTimer);
    shopProspectorTypeTimer = null;
  }
  if (shopProspectorTalkTimer) clearTimeout(shopProspectorTalkTimer);
  startShopProspectorTalking();

  shopProspectorTextEl.textContent = '';
  const startAt = performance.now();
  const step = () => {
    if (runId !== shopProspectorAnimRunId) return;
    const elapsed = performance.now() - startAt;
    const progress = Math.min(1, elapsed / SHOP_PROSPECTOR_TYPE_MS);
    const nextLen = Math.max(1, Math.floor(line.length * progress));
    shopProspectorTextEl.textContent = line.slice(0, nextLen);
    if (progress >= 1) {
      shopProspectorTextEl.textContent = line;
      shopProspectorTalkTimer = setTimeout(() => {
        if (runId !== shopProspectorAnimRunId) return;
        stopShopProspectorTalking();
      }, 120);
      return;
    }
    shopProspectorTypeTimer = setTimeout(step, 16);
  };
  step();
}

function showUpgradePurchaseEffect(upgradeKey, cost = 0, level = 0) {
  const safeCost = Number.isFinite(cost) ? Math.max(0, cost) : 0;
  const buyChimes = Math.max(2, Math.min(7, Math.ceil(safeCost * 1.5)));
  AudioManager.play('synth', 0.45);
  AudioManager.playCoins(buyChimes, 0.45);

  if (shopPanelEl) {
    shopPanelEl.classList.remove('purchase-flash');
    void shopPanelEl.offsetWidth;
    shopPanelEl.classList.add('purchase-flash');
    setTimeout(() => shopPanelEl.classList.remove('purchase-flash'), 300);
  }

  if (!upgradeKey) return;
  const row = document.querySelector(`#upgrade-shop .upgrade-item[data-upgrade="${upgradeKey}"]`);
  if (!row) return;

  row.classList.remove('purchase-pop');
  void row.offsetWidth;
  row.classList.add('purchase-pop');
  setTimeout(() => row.classList.remove('purchase-pop'), 420);

  const rect = row.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const burstCount = 10;
  for (let i = 0; i < burstCount; i++) {
    const spark = document.createElement('div');
    spark.className = 'shop-purchase-spark';
    spark.style.left = (cx + (Math.random() - 0.5) * 24) + 'px';
    spark.style.top = (cy + (Math.random() - 0.5) * 24) + 'px';
    const angle = (i / burstCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const distance = 26 + Math.random() * 40;
    const rise = 10 + Math.random() * 24;
    spark.style.setProperty('--spark-x', (Math.cos(angle) * distance).toFixed(1) + 'px');
    spark.style.setProperty('--spark-y', (Math.sin(angle) * distance - rise).toFixed(1) + 'px');
    document.body.appendChild(spark);
    setTimeout(() => spark.remove(), 550);
  }

  const label = document.createElement('div');
  label.className = 'shop-purchase-float';
  label.textContent = `UPGRADED TO LV ${Math.max(0, Number(level) || 0)}!`;
  label.style.left = cx + 'px';
  label.style.top = (rect.top + 6) + 'px';
  document.body.appendChild(label);
  setTimeout(() => label.remove(), 850);
}

function getVisibleStatEl(desktopEl, mobileEl) {
  if (window.innerWidth <= 640 && mobileEl && mobileEl.getClientRects().length > 0) {
    return mobileEl;
  }
  return desktopEl;
}

// ==================== NETWORK ====================
let ws = null;
let connected = false;
let sessionToken = localStorage.getItem('roach_session_token');
let onboardingToken = null;
let onboardingSeen = false;
let onboardingIntroQueued = false;

function getOnboardingStorageKey(token) {
  return token ? `roach_onboarded_${token}` : null;
}

function loadOnboardingState(token) {
  onboardingToken = token || null;
  const key = getOnboardingStorageKey(onboardingToken);
  onboardingSeen = key ? localStorage.getItem(key) === '1' : false;
}

function markOnboardingSeen() {
  onboardingSeen = true;
  const key = getOnboardingStorageKey(onboardingToken);
  if (key) localStorage.setItem(key, '1');
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    connected = true;
    statusEl.textContent = 'Connected';
    statusEl.className = 'connected';

    // Build reconnect message with optional platform identity
    const platformUser = platform.getUser();
    const msg = { type: 'reconnect' };
    if (sessionToken) msg.token = sessionToken;
    if (platformUser) {
      msg.platformType = platformUser.platformType;
      msg.platformId = platformUser.platformId;
      msg.platformName = platformUser.name;
    }
    if (msg.token || msg.platformType) {
      send(msg);
    }
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
      if (msg.token) {
        sessionToken = msg.token;
        localStorage.setItem('roach_session_token', msg.token);
      }
      loadOnboardingState(sessionToken || msg.token || null);
      if (!onboardingSeen && !onboardingIntroQueued) {
        onboardingIntroQueued = true;
        setTimeout(() => showTutorial(), 2000);
      }
      buildMinimap();
      applySnapshot(msg.snapshot);
      motelData = msg.motel;
      if (msg.restored) {
        log(`<span style="color:#0f0">Reconnected as ${escapeHtml(myName)}! Progress restored.</span>`);
        AudioManager.play('synth', 0.5);
      } else {
        log(`<span style="color:#0ff">You are ${escapeHtml(myName)}!</span>`);
        log('Your roach is <span style="color:#0ff">CYAN</span>. <span style="color:#a00">RED BOOTS</span> hunt wealthy roaches.');
      }
      if (msg.linkedPlatform) {
        log(`<span style="color:#ff0">Account linked to ${escapeHtml(msg.linkedPlatform)}! Your progress syncs across devices.</span>`);
      }
      applyUpgradeState(msg.upgrades);
      if (Number.isFinite(msg.stompCooldown)) {
        setStompCooldownMs(msg.stompCooldown);
      }
      renderUpgradeShop();
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

      break;
    case 'upgrade_purchased': {
      const def = UPGRADE_DEFS[msg.upgrade];
      if (def) {
        const bankSpent = Number.isFinite(msg.usedFromBank) ? msg.usedFromBank : 0;
        const cashSpent = Number.isFinite(msg.usedFromCash) ? msg.usedFromCash : 0;
        log(
          `<span style="color:#8f8">${escapeHtml(def.label)} upgraded to Lv ${msg.level}</span> ` +
          `<span class="money">-$${Number(msg.cost || 0).toFixed(2)}</span> ` +
          `<span style="color:#f0c040">(bank $${bankSpent.toFixed(2)} + wallet $${cashSpent.toFixed(2)})</span>`
        );
      }
      if (Number.isFinite(msg.balance)) {
        balance = msg.balance;
      }
      if (Number.isFinite(msg.banked)) {
        bankedBalance = msg.banked;
      }
      applyUpgradeState(msg.upgrades);
      if (Number.isFinite(msg.stompCooldown)) {
        setStompCooldownMs(msg.stompCooldown);
      }
      renderUpgradeShop();
      showUpgradePurchaseEffect(msg.upgrade, Number(msg.cost), msg.level);
      break;
    }
    case 'upgrade_purchase_failed': {
      const def = UPGRADE_DEFS[msg.upgrade];
      if (!def) break;
      if (msg.reason === 'max_level') {
        log(`<span style="color:#f0c040">${escapeHtml(def.label)} is already maxed.</span>`);
      } else if (msg.reason === 'insufficient_funds' && Number.isFinite(msg.cost)) {
        const have = Number.isFinite(msg.availableFunds) ? msg.availableFunds : (balance + bankedBalance);
        log(`<span style="color:#f66">Need $${msg.cost.toFixed(2)} for ${escapeHtml(def.label)} (have $${have.toFixed(2)}).</span>`);
      }
      break;
    }
  }
}

function handleTick(msg) {
  const room = msg.room;

  // Update player stats
  if (msg.you) {
    balance = msg.you.balance;
    bankedBalance = msg.you.banked;
    lastServerSeq = msg.you.lastInputSeq;
    if (msg.you.upgrades) {
      applyUpgradeState(msg.you.upgrades);
    }
    if (Number.isFinite(msg.you.stompCooldown)) {
      setStompCooldownMs(msg.you.stompCooldown);
    }
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

  // Minimap
  if (msg.minimap) {
    minimapData = msg.minimap;
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
      if (Number.isFinite(c.bootScale)) {
        bootEl.style.setProperty('--boot-scale', c.bootScale.toFixed(3));
      } else {
        bootEl.style.setProperty('--boot-scale', '1');
      }
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

  // Wall bounce powerup: stronger rebounds at world boundaries.
  const [roomX, roomY] = currentRoom.split(',').map(Number);
  const bounceLevel = upgrades.wallBounce || 0;
  if (bounceLevel > 0) {
    const bounceStrength = 0.55 + Math.min(2.2, bounceLevel * 0.04);
    if (roomX === 0 && predictedX < -5) {
      predictedX = -5;
      predictedVx = Math.abs(predictedVx) * bounceStrength + 0.2;
    }
    if (roomX === gridSize - 1 && predictedX > CONTAINER_WIDTH + 5) {
      predictedX = CONTAINER_WIDTH + 5;
      predictedVx = -Math.abs(predictedVx) * bounceStrength - 0.2;
    }
    if (roomY === 0 && predictedY < -5) {
      predictedY = -5;
      predictedVy = Math.abs(predictedVy) * bounceStrength + 0.2;
    }
    if (roomY === gridSize - 1 && predictedY > CONTAINER_HEIGHT + 5) {
      predictedY = CONTAINER_HEIGHT + 5;
      predictedVy = -Math.abs(predictedVy) * bounceStrength - 0.2;
    }
  }

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

  // Radar minimap — render at 60fps for smooth sweep
  if (window.innerWidth <= 640) {
    renderMinimap(document.getElementById('mobile-minimap-canvas'));
  } else {
    renderMinimap(document.getElementById('minimap-canvas'));
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

  // Player count
  let playerCount = 0;
  for (const [, entry] of roachEls) {
    if (entry.data.isPlayer) playerCount++;
  }
  document.getElementById('player-count').textContent = `Players in room: ${playerCount}`;

  renderUpgradeShop();
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

function showShockwave(x, y, scale = 1) {
  const ring = document.createElement('div');
  ring.className = 'shockwave';
  const scaledSize = Math.max(50, 120 * scale);
  ring.style.width = scaledSize + 'px';
  ring.style.height = scaledSize + 'px';
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

// Minimap state
let minimapData = null; // { 'x,y': { roaches: [{x,y,p,id},...], bots: [{x,y},...] }, ... }
const RADAR_PERIOD = 3000; // ms for one full sweep

function buildMinimap() {
  resizeMinimapCanvases();
  // Retry after layout settles (covers cases where parent has no width yet)
  requestAnimationFrame(() => resizeMinimapCanvases());
}

function resizeMinimapCanvases() {
  // Desktop minimap — match sidebar width
  const desktopCanvas = document.getElementById('minimap-canvas');
  if (desktopCanvas) {
    const parent = desktopCanvas.parentElement;
    if (parent && parent.clientWidth > 0) {
      const w = Math.min(parent.clientWidth, 220);
      const cellW = Math.floor(w / gridSize);
      const cellH = Math.floor(cellW * (2 / 3));
      desktopCanvas.width = cellW * gridSize;
      desktopCanvas.height = cellH * gridSize;
    }
  }

  // Mobile minimap
  const mobileCanvas = document.getElementById('mobile-minimap-canvas');
  if (mobileCanvas) {
    const parent = mobileCanvas.parentElement;
    if (parent && parent.clientWidth > 0) {
      const w = parent.clientWidth;
      const cellW = Math.floor(w / gridSize);
      const cellH = Math.floor(cellW * (2 / 3));
      mobileCanvas.width = cellW * gridSize;
      mobileCanvas.height = cellH * gridSize;
    }
  }
}

// Returns 0..1 brightness based on how recently the sweep passed this angle
function radarBrightness(entityAngle, sweepAngle) {
  let diff = sweepAngle - entityAngle;
  // Normalize to 0..2PI (how far behind the sweep the entity is)
  diff = ((diff % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  // Entities just swept = diff near 0, fading trail behind
  if (diff < Math.PI * 0.8) {
    return 1 - diff / (Math.PI * 0.8);
  }
  return 0;
}

function renderMinimap(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cellW = Math.floor(w / gridSize);
  const cellH = Math.floor(h / gridSize);
  const gap = 1;

  const now = Date.now();
  const sweepAngle = ((now % RADAR_PERIOD) / RADAR_PERIOD) * Math.PI * 2;

  // Dark background
  ctx.fillStyle = '#0a0f0a';
  ctx.fillRect(0, 0, w, h);

  const motelRoom = motelData && motelData.active ? motelData.room : null;
  const cx = w / 2;
  const cy = h / 2;
  const maxRadius = Math.sqrt(cx * cx + cy * cy);

  // Radar sweep cone (drawn over the whole minimap)
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Draw sweep as a filled arc trailing behind the line
  const trailAngle = Math.PI * 0.4;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, maxRadius, sweepAngle - trailAngle, sweepAngle);
  ctx.closePath();
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxRadius);
  grad.addColorStop(0, 'rgba(0, 255, 0, 0.12)');
  grad.addColorStop(0.5, 'rgba(0, 255, 0, 0.06)');
  grad.addColorStop(1, 'rgba(0, 255, 0, 0.02)');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  // Sweep line
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweepAngle) * maxRadius, cy + Math.sin(sweepAngle) * maxRadius);
  ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Draw grid and entities
  for (let gy = 0; gy < gridSize; gy++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const roomKey = `${gx},${gy}`;
      const x0 = gx * cellW + gap;
      const y0 = gy * cellH + gap;
      const cw = cellW - gap * 2;
      const ch = cellH - gap * 2;

      // Room border
      if (roomKey === currentRoom) {
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.6)';
      } else if (roomKey === motelRoom) {
        ctx.strokeStyle = 'rgba(240, 192, 64, 0.4)';
      } else {
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.15)';
      }
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, cw - 1, ch - 1);

      // Crosshair in center of each cell
      const cellCx = x0 + cw / 2;
      const cellCy = y0 + ch / 2;
      ctx.strokeStyle = 'rgba(0, 255, 0, 0.07)';
      ctx.beginPath();
      ctx.moveTo(cellCx, y0 + 2);
      ctx.lineTo(cellCx, y0 + ch - 2);
      ctx.moveTo(x0 + 2, cellCy);
      ctx.lineTo(x0 + cw - 2, cellCy);
      ctx.stroke();

      // Draw entities from minimap data
      if (minimapData && minimapData[roomKey]) {
        const room = minimapData[roomKey];
        const scaleX = cw / CONTAINER_WIDTH;
        const scaleY = ch / CONTAINER_HEIGHT;

        // AI roaches - green radar blips
        for (const r of room.roaches) {
          if (r.p) continue;
          const rx = x0 + r.x * scaleX;
          const ry = y0 + r.y * scaleY;
          const angle = Math.atan2(ry - cy, rx - cx);
          const b = radarBrightness(angle, sweepAngle);
          if (b > 0.05) {
            const alpha = (0.3 + b * 0.7).toFixed(2);
            ctx.fillStyle = `rgba(0, 200, 0, ${alpha})`;
            ctx.fillRect(rx - 1, ry - 1, 2, 2);
          }
        }

        // Bots - red blips
        for (const bot of room.bots) {
          const bx = x0 + bot.x * scaleX;
          const by = y0 + bot.y * scaleY;
          const angle = Math.atan2(by - cy, bx - cx);
          const b = radarBrightness(angle, sweepAngle);
          if (b > 0.05) {
            const alpha = (0.4 + b * 0.6).toFixed(2);
            ctx.fillStyle = `rgba(255, 50, 0, ${alpha})`;
            ctx.fillRect(bx - 1.5, by - 1.5, 3, 3);
          }
        }

        // Player roaches - brighter, always partially visible
        for (const r of room.roaches) {
          if (!r.p) continue;
          const rx = x0 + r.x * scaleX;
          const ry = y0 + r.y * scaleY;
          const angle = Math.atan2(ry - cy, rx - cx);
          const b = radarBrightness(angle, sweepAngle);
          const baseAlpha = 0.4; // always partially visible
          const alpha = Math.min(1, baseAlpha + b * 0.6).toFixed(2);
          if (r.id === myId) {
            ctx.fillStyle = `rgba(0, 255, 255, ${alpha})`;
          } else {
            ctx.fillStyle = `rgba(255, 0, 255, ${alpha})`;
          }
          ctx.fillRect(rx - 1.5, ry - 1.5, 3, 3);
          // Glow on fresh sweep
          if (b > 0.5) {
            ctx.fillStyle = r.id === myId
              ? `rgba(0, 255, 255, ${(b * 0.3).toFixed(2)})`
              : `rgba(255, 0, 255, ${(b * 0.3).toFixed(2)})`;
            ctx.fillRect(rx - 3, ry - 3, 6, 6);
          }
        }
      }

      // Motel indicator
      if (roomKey === motelRoom && motelData) {
        const mx = x0 + motelData.x / CONTAINER_WIDTH * cw;
        const my = y0 + motelData.y / CONTAINER_HEIGHT * ch;
        const angle = Math.atan2(my - cy, mx - cx);
        const b = radarBrightness(angle, sweepAngle);
        const alpha = Math.min(1, 0.5 + b * 0.5).toFixed(2);
        ctx.fillStyle = `rgba(240, 192, 64, ${alpha})`;
        ctx.fillRect(mx - 2, my - 2, 4, 4);
      }
    }
  }
}

function setBootTransform(angleDeg = 0) {
  const bootScale = getBootScale(upgrades.bootSize);
  boot.style.setProperty('--boot-scale', bootScale.toFixed(3));
  boot.style.transform = `translateX(-50%) translateY(-80%) rotate(${angleDeg}deg) scale(${bootScale})`;
}

function showStompImpacts(x, y) {
  const bootScale = getBootScale(upgrades.bootSize);
  const bootWidth = BOOT_WIDTH * bootScale;
  const bootHeight = BOOT_HEIGHT * bootScale;
  const zones = [
    { dx: 0, dy: 0 },
    ...getMultiStompOffsets(upgrades.multiStomp, bootWidth, bootHeight),
  ];
  const visualZones = zones.slice(0, 16);
  for (const zone of visualZones) {
    const impactX = Math.max(0, Math.min(CONTAINER_WIDTH, x + zone.dx));
    const impactY = Math.max(0, Math.min(CONTAINER_HEIGHT, y + zone.dy));
    showShockwave(impactX, impactY - bootHeight * 0.3, Math.max(0.7, bootScale * 0.85));
  }
}

function tryLocalStomp(x, y) {
  const now = Date.now();
  if (now - lastLocalStompAt < stompCooldownMs) return;
  lastLocalStompAt = now;

  boot.classList.remove('stomping');
  void boot.offsetWidth;
  boot.classList.add('stomping');
  showStompImpacts(x, y);
  shakeScreen();
  AudioManager.play('click', 0.3);

  send({ type: 'stomp', x, y, seq: inputSeq });
}

// ==================== INPUT ====================
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    setShopModalOpen(false);
    return;
  }

  const k = e.key.toLowerCase();
  if (shopModal && shopModal.classList.contains('visible')) {
    if (k in keys || e.key === ' ') {
      e.preventDefault();
    }
    return;
  }

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
  setBootTransform(bootTilt);
});

container.addEventListener('click', (e) => {
  const rect = container.getBoundingClientRect();
  const x = (e.clientX - rect.left) / scaleFactor;
  const y = (e.clientY - rect.top) / scaleFactor;
  tryLocalStomp(x, y);
});

document.getElementById('heal-btn').addEventListener('click', () => {
  send({ type: 'heal' });
});
document.getElementById('mobile-heal-btn')?.addEventListener('click', () => {
  send({ type: 'heal' });
});
openShopBtn?.addEventListener('click', () => setShopModalOpen(true));
mobileOpenShopBtn?.addEventListener('click', () => setShopModalOpen(true));
closeShopBtn?.addEventListener('click', () => setShopModalOpen(false));
for (const tabBtn of shopCategoryTabBtns) {
  tabBtn.addEventListener('click', () => setStoreTab(tabBtn.dataset.storeTab || 'boot'));
}
shopModal?.addEventListener('click', (e) => {
  if (e.target === shopModal) setShopModalOpen(false);
});
document.querySelectorAll('#upgrade-shop .upgrade-item').forEach((item) => {
  const key = item.dataset.upgrade || null;
  item.addEventListener('mouseenter', () => setShopProspectorLine(key));
});
for (const key of UPGRADE_ORDER) {
  const btn = document.getElementById(`upgrade-btn-${key}`);
  btn?.addEventListener('click', () => tryPurchaseUpgrade(key));
  btn?.addEventListener('focus', () => setShopProspectorLine(key));
}
window.addEventListener('resize', () => setStoreTab(currentStoreTab, true));

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
  setBootTransform(0);
  tryLocalStomp(x, y);
});
container.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const touch = e.changedTouches[0];
  const rect = container.getBoundingClientRect();
  mouseX = (touch.clientX - rect.left) / scaleFactor;
  mouseY = (touch.clientY - rect.top) / scaleFactor;
  boot.style.left = mouseX + 'px';
  boot.style.top = mouseY + 'px';
  setBootTransform(0);
});
container.addEventListener('touchend', () => {
  boot.classList.remove('hovering');
  mouseInContainer = false;
});

// ==================== PROSPECTOR NPC ====================
// ==================== TUTORIAL OVERLAY ====================
const tutorialOverlay = document.getElementById('tutorial-overlay');

function showTutorial() {
  tutorialOverlay.classList.add('visible');
}

function hideTutorial() {
  tutorialOverlay.classList.remove('visible');
  markOnboardingSeen();
}

document.getElementById('btn-close-tutorial').addEventListener('click', hideTutorial);

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
applyUpgradeState(upgrades);
renderUpgradeShop();
setStoreTab(currentStoreTab, true);
setBootTransform(0);

// Initialize platform adapter (detects Farcaster/Base/World) then connect
platform.init().then(() => {
  if (platform.isEmbedded) {
    console.log(`[roach] Running as ${platform.type} miniapp`);
  }
  connect();
}).catch(() => {
  // Platform detection failed — connect standalone
  connect();
});

gameLoop();
