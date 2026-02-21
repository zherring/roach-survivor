import {
  TICK_RATE, TICKS_PER_SEC, GRID_SIZE, CONTAINER_WIDTH, CONTAINER_HEIGHT,
  ROACH_WIDTH, ROACH_HEIGHT, HEAL_COST, MAX_HP, BASE_HP, HP_DECAY_RATE,
  UPGRADE_DEFS, getUpgradeCost, sanitizeUpgrades, createDefaultUpgrades,
  getStompCooldownForLevel, getBootScale,
} from '../shared/constants.js';
import { Room } from './room.js';
import { Roach } from './roach.js';
import { Motel } from './motel.js';
import { db } from './db.js';

const ADJECTIVES = ['Speedy', 'Sneaky', 'Giant', 'Tiny', 'Stinky', 'Slimy', 'Crunchy', 'Greasy', 'Fuzzy', 'Crusty'];
const NOUNS = ['Roach', 'Bug', 'Crawler', 'Scuttler', 'Skitter', 'Creeper', 'Muncher', 'Nibbler', 'Dasher', 'Lurker'];
const INVALID_CURSOR = -1;
const MAX_INPUT_OVERSHOOT = 200;
const MAX_MESSAGES_PER_SECOND = 60;
const HEAL_COOLDOWN = 200; // ms between heal attempts
const MAX_ABS_INPUT_VELOCITY = 50;
const MAX_INPUT_SEQUENCE = 2_147_483_647;

function toFiniteNumber(value) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

function toFiniteInteger(value) {
  const num = toFiniteNumber(value);
  if (num === null || !Number.isInteger(num)) return null;
  return num;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function sanitizeInputMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;

  const x = toFiniteNumber(msg.x);
  const y = toFiniteNumber(msg.y);
  const vx = toFiniteNumber(msg.vx);
  const vy = toFiniteNumber(msg.vy);
  if (x === null || y === null || vx === null || vy === null) return null;

  const seq = toFiniteInteger(msg.seq);
  const cursorX = toFiniteNumber(msg.cursorX);
  const cursorY = toFiniteNumber(msg.cursorY);
  const hasCursor = cursorX !== null && cursorY !== null;

  return {
    x: clamp(x, -MAX_INPUT_OVERSHOOT, CONTAINER_WIDTH + MAX_INPUT_OVERSHOOT),
    y: clamp(y, -MAX_INPUT_OVERSHOOT, CONTAINER_HEIGHT + MAX_INPUT_OVERSHOOT),
    vx: clamp(vx, -MAX_ABS_INPUT_VELOCITY, MAX_ABS_INPUT_VELOCITY),
    vy: clamp(vy, -MAX_ABS_INPUT_VELOCITY, MAX_ABS_INPUT_VELOCITY),
    seq: seq === null ? null : clamp(seq, 0, MAX_INPUT_SEQUENCE),
    cursorX: hasCursor ? clamp(cursorX, 0, CONTAINER_WIDTH) : INVALID_CURSOR,
    cursorY: hasCursor ? clamp(cursorY, 0, CONTAINER_HEIGHT) : INVALID_CURSOR,
  };
}

function sanitizeStompMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const x = toFiniteNumber(msg.x);
  const y = toFiniteNumber(msg.y);
  if (x === null || y === null) return null;
  const seq = toFiniteInteger(msg.seq);

  return {
    x: clamp(x, 0, CONTAINER_WIDTH),
    y: clamp(y, 0, CONTAINER_HEIGHT),
    seq: seq === null ? 0 : clamp(seq, 0, MAX_INPUT_SEQUENCE),
  };
}

function sanitizeUpgradePurchaseMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.upgrade !== 'string') return null;
  const key = msg.upgrade.trim();
  return Object.prototype.hasOwnProperty.call(UPGRADE_DEFS, key) ? key : null;
}

export class GameServer {
  constructor() {
    this.rooms = new Map();
    this.players = new Map(); // playerId -> { ws, roach, room, bankedBalance, upgrades, lastStomp }
    this.motel = new Motel();
    this.tickCount = 0;
    this.botAdjustTimer = 0;
    this.sessionSaveTimer = 0;
    this.leaderboardCache = [];
    this.leaderboardTimer = 0;
    this.sessionSaveInFlight = false;
    this.leaderboardRefreshInFlight = false;
    this.tickInterval = null;

    // Create 3x3 grid
    for (let x = 0; x < GRID_SIZE; x++) {
      for (let y = 0; y < GRID_SIZE; y++) {
        const key = `${x},${y}`;
        const room = new Room(key);
        room.addNpcRoaches(8);
        room.adjustBots(); // Seed initial bots immediately
        this.rooms.set(key, room);
      }
    }
  }

  async init() {
    const cleaned = await db.cleanStaleSessions();
    if (cleaned) console.log(`Cleaned ${cleaned} stale sessions`);
    try {
      this.leaderboardCache = await db.getLeaderboard(20);
    } catch (e) {
      console.error('Failed to load initial leaderboard:', e.message);
    }
  }

  start() {
    this.tickInterval = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        console.error('Tick error:', err?.stack || err?.message || err);
      }
    }, TICK_RATE);
    console.log(`Game server started: ${GRID_SIZE}x${GRID_SIZE} grid, ${TICK_RATE}ms tick`);
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  async addPlayer(ws, reconnectToken = null, platformInfo = null) {
    let token = reconnectToken;
    let name, roomKey, bankedBalance, restored;
    let isPaid = false;
    let upgrades = createDefaultUpgrades();
    let linkedPlatform = null;
    let linkedIdentity = null;
    let walletAddress = null;
    let totalKills = 0;

    // Try to restore via platform identity first (cross-device persistence)
    let session = null;
    if (!token && platformInfo && platformInfo.platformType && platformInfo.platformId) {
      const platformPlayer = await db.getPlayerByPlatform(platformInfo.platformType, platformInfo.platformId);
      if (platformPlayer) {
        token = platformPlayer.id;
        console.log(`Player found via platform identity: ${platformInfo.platformType}:${platformInfo.platformId}`);
      }
    }

    // Try to restore from DB via token
    if (token) {
      const existing = await db.getPlayer(token);
      if (existing) {
        name = existing.name;
        bankedBalance = existing.banked_balance;
        isPaid = !!existing.paid_account;
        walletAddress = existing.wallet_address || null;
        totalKills = Number(existing.total_kills) || 0;
        if (existing.platform_type && existing.platform_id) {
          linkedIdentity = `${existing.platform_type}:${existing.platform_id}`;
        }
        upgrades = sanitizeUpgrades({
          bootSize: existing.boot_size_level,
          multiStomp: existing.multi_stomp_level,
          rateOfFire: existing.rate_of_fire_level,
          goldMagnet: existing.gold_magnet_level,
          wallBounce: existing.wall_bounce_level,
          idleIncome: existing.idle_income_level,
          shellArmor: existing.shell_armor_level,
        });
        session = await db.getSession(token);
        roomKey = session ? session.room : '1,1';
        // Validate room exists
        if (!this.rooms.has(roomKey)) roomKey = '1,1';
        restored = !!session;

        // Link platform identity to this player if not already linked
        if (platformInfo && platformInfo.platformType && platformInfo.platformId && !existing.platform_id) {
          await db.linkPlatform(token, platformInfo.platformType, platformInfo.platformId);
          linkedPlatform = platformInfo.platformType;
          linkedIdentity = `${platformInfo.platformType}:${platformInfo.platformId}`;
          console.log(`Linked ${platformInfo.platformType}:${platformInfo.platformId} to player ${token.slice(0, 8)}...`);
        }

        console.log(`Player reconnecting: ${name} (${token.slice(0, 8)}...)${restored ? ' [session restored]' : ''}`);
      } else {
        token = null; // Invalid token, treat as new
      }
    }

    // New player
    if (!token) {
      name = platformInfo?.name ||
        `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
      token = await db.createPlayer(name);
      roomKey = '1,1';
      bankedBalance = 0;
      restored = false;
      upgrades = createDefaultUpgrades();
      walletAddress = null;
      totalKills = 0;

      // Link platform identity to new player
      if (platformInfo && platformInfo.platformType && platformInfo.platformId) {
        await db.linkPlatform(token, platformInfo.platformType, platformInfo.platformId);
        linkedPlatform = platformInfo.platformType;
        linkedIdentity = `${platformInfo.platformType}:${platformInfo.platformId}`;
        console.log(`New player linked to ${platformInfo.platformType}:${platformInfo.platformId}`);
      }
    }

    const room = this.rooms.get(roomKey);
    const roach = new Roach(true, session ? session.balance : 0, name);
    if (session) {
      roach.x = session.position_x;
      roach.y = session.position_y;
      roach.hp = session.hp;
    }
    room.roaches.push(roach);

    const player = {
      ws,
      roach,
      room: roomKey,
      token,
      bankedBalance: bankedBalance || 0,
      upgrades,
      isPaid: isPaid || false,
      linkedIdentity,
      walletAddress,
      totalKills,
      lastStomp: 0,
      lastHeal: 0,
      cursorX: INVALID_CURSOR,
      cursorY: INVALID_CURSOR,
      msgCount: 0,
      msgWindowStart: Date.now(),
    };
    roach.upgrades = player.upgrades;
    this.players.set(roach.id, player);

    // Send welcome with full snapshot
    const welcomeMsg = {
      type: 'welcome',
      id: roach.id,
      token,
      name,
      room: roomKey,
      snapshot: room.serialize(),
      motel: this.motel.serialize(),
      gridSize: GRID_SIZE,
      restored,
      isPaid,
      upgrades: { ...upgrades },
      stompCooldown: getStompCooldownForLevel(upgrades.rateOfFire),
      linkedPlatform: linkedPlatform || undefined,
      leaderboard: this.leaderboardCache,
      account: {
        walletAddress: player.walletAddress,
        linkedIdentity: player.linkedIdentity,
        totalKills: player.totalKills,
      },
    };
    this.send(ws, welcomeMsg);

    console.log(`Player joined: ${name} (${roach.id}) in room ${roomKey}`);
    return roach.id;
  }

  async removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    // Only save session for paid players (free players lose progress on disconnect)
    if (player.token && player.isPaid) {
      await db.updateSession(
        player.token, player.room,
        player.roach.x, player.roach.y,
        player.roach.balance, player.roach.hp
      );
      await db.updateUpgrades(player.token, player.upgrades);
    }

    const room = this.rooms.get(player.room);
    if (room) {
      const idx = room.roaches.indexOf(player.roach);
      if (idx > -1) room.roaches.splice(idx, 1);
    }

    console.log(`Player left: ${player.roach.name} (${playerId})`);
    this.players.delete(playerId);
  }

  async handleMessage(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player) return;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    // Rate limit: drop messages if exceeding budget
    const now = Date.now();
    if (now - player.msgWindowStart > 1000) {
      player.msgCount = 0;
      player.msgWindowStart = now;
    }
    player.msgCount++;
    if (player.msgCount > MAX_MESSAGES_PER_SECOND) return;

    switch (msg.type) {
      case 'input': {
        const input = sanitizeInputMessage(msg);
        if (!input) break;

        player.roach.pendingPos = { x: input.x, y: input.y, vx: input.vx, vy: input.vy };
        if (input.seq !== null && input.seq >= player.roach.lastInputSeq) {
          player.roach.lastInputSeq = input.seq;
        }

        player.cursorX = input.cursorX;
        player.cursorY = input.cursorY;
        break;
      }
      case 'stomp': {
        const stomp = sanitizeStompMessage(msg);
        if (!stomp) break;

        const now = Date.now();
        const stompCooldown = getStompCooldownForLevel(player.upgrades.rateOfFire);
        if (now - player.lastStomp < stompCooldown) break;
        player.lastStomp = now;
        const room = this.rooms.get(player.room);
        if (room) {
          room.pendingStomps.push({
            playerId,
            x: stomp.x,
            y: stomp.y,
            seq: stomp.seq,
            upgrades: { ...player.upgrades },
          });
        }
        break;
      }
      case 'heal': {
        const healNow = Date.now();
        if (healNow - player.lastHeal < HEAL_COOLDOWN) break;
        const roach = player.roach;
        if (roach.balance < HEAL_COST) break;
        player.lastHeal = healNow;
        roach.balance -= HEAL_COST;
        roach.hp += 1; // additive — no cap, decays back to BASE_HP over time
        roach.healCount++;
        break;
      }
      case 'buy_upgrade': {
        if (!player.isPaid) {
          this.send(player.ws, {
            type: 'upgrade_purchase_failed',
            upgrade: msg.upgrade || '',
            reason: 'not_paid',
          });
          break;
        }
        const upgradeKey = sanitizeUpgradePurchaseMessage(msg);
        if (!upgradeKey) break;

        const currentLevel = player.upgrades[upgradeKey] || 0;
        const def = UPGRADE_DEFS[upgradeKey];
        if (!def) break;

        if (currentLevel >= def.maxLevel) {
          this.send(player.ws, {
            type: 'upgrade_purchase_failed',
            upgrade: upgradeKey,
            reason: 'max_level',
          });
          break;
        }

        const cost = getUpgradeCost(upgradeKey, currentLevel);
        const availableFunds = player.bankedBalance + player.roach.balance;
        if (availableFunds < cost) {
          this.send(player.ws, {
            type: 'upgrade_purchase_failed',
            upgrade: upgradeKey,
            reason: 'insufficient_funds',
            cost,
            availableFunds,
          });
          break;
        }

        let remaining = cost;
        const usedFromCash = Math.min(player.roach.balance, remaining);
        player.roach.balance -= usedFromCash;
        remaining -= usedFromCash;
        const usedFromBank = Math.min(player.bankedBalance, remaining);
        player.bankedBalance -= usedFromBank;
        remaining -= usedFromBank;

        player.upgrades[upgradeKey] = currentLevel + 1;
        player.roach.upgrades = player.upgrades;
        if (player.token) {
          await db.updateUpgrades(player.token, player.upgrades);
          if (usedFromBank > 0) {
            await db.updateBankedBalance(player.token, player.bankedBalance);
          }
        }
        this.send(player.ws, {
          type: 'upgrade_purchased',
          upgrade: upgradeKey,
          level: player.upgrades[upgradeKey],
          cost,
          usedFromBank,
          usedFromCash,
          upgrades: { ...player.upgrades },
          stompCooldown: getStompCooldownForLevel(player.upgrades.rateOfFire),
          balance: player.roach.balance,
          banked: player.bankedBalance,
        });
        break;
      }
    }
  }

  tick() {
    const now = Date.now();
    this.tickCount++;
    const allEvents = [];

    // Simulate each room
    for (const [key, room] of this.rooms) {
      // Collect player cursors in this room for NPC flee
      const cursors = [];
      for (const [id, p] of this.players) {
        if (p.room === key
            && Number.isFinite(p.cursorX) && Number.isFinite(p.cursorY)
            && p.cursorX >= 0 && p.cursorY >= 0) {
          cursors.push({ x: p.cursorX, y: p.cursorY });
        }
      }
      const events = room.simulate(now, cursors);
      for (const evt of events) {
        evt.room = key;
        allEvents.push(evt);
      }

      // Check room transitions for players
      const playerRoaches = room.roaches.filter(r => r.isPlayer);
      for (const roach of playerRoaches) {
        const player = this.players.get(roach.id);
        const wallBounceLevel = player?.upgrades?.wallBounce || 0;
        const transition = room.checkTransition(roach, wallBounceLevel);
        if (transition) {
          this.transitionPlayer(roach.id, key, `${transition.nx},${transition.ny}`, transition.dir);
        }
      }
    }

    // Update motel
    const motelEvents = this.motel.update(now, this.rooms);
    for (const evt of motelEvents) {
      if (evt.type === 'bank') {
        const player = this.players.get(evt.playerId);
        if (player) {
          player.bankedBalance += player.roach.balance;
          player.roach.balance = 0;
          evt.totalBanked = player.bankedBalance;
          if (player.token) {
            db.updateBankedBalance(player.token, player.bankedBalance).catch(err => console.error('DB bank error:', err.message));
          }
        }
      }
      allEvents.push(evt);
    }

    // Track kills in DB (fire-and-forget)
    for (const evt of allEvents) {
      if (evt.type === 'stomp_kill' && evt.stomperId) {
        const killer = this.players.get(evt.stomperId);
        if (killer && killer.token) {
          killer.totalKills = (killer.totalKills || 0) + 1;
          db.incrementKills(killer.token).catch(err => console.error('DB kill error:', err.message));
        }
      }
    }

    // HP decay: player HP above BASE_HP decays at HP_DECAY_RATE per second
    const hpDecayPerTick = HP_DECAY_RATE / TICKS_PER_SEC;
    for (const [, player] of this.players) {
      const roach = player.roach;
      if (!roach.isDead && roach.hp > BASE_HP) {
        roach.hp = Math.max(BASE_HP, roach.hp - hpDecayPerTick);
      }
    }

    // Periodic session save (every 200 ticks = ~10s)
    this.sessionSaveTimer++;
    if (this.sessionSaveTimer >= 200) {
      this.sessionSaveTimer = 0;
      if (!this.sessionSaveInFlight) {
        this.sessionSaveInFlight = true;
        this.saveSessions()
          .catch(err => console.error('DB session save error:', err.message))
          .finally(() => {
            this.sessionSaveInFlight = false;
          });
      }
    }

    // Refresh leaderboard cache every 100 ticks (~5s)
    this.leaderboardTimer++;
    if (this.leaderboardTimer >= 100) {
      this.leaderboardTimer = 0;
      if (!this.leaderboardRefreshInFlight) {
        this.leaderboardRefreshInFlight = true;
        db.getLeaderboard(20)
          .then(rows => {
            this.leaderboardCache = rows;
          })
          .catch(err => console.error('DB leaderboard error:', err.message))
          .finally(() => {
            this.leaderboardRefreshInFlight = false;
          });
      }
    }

    // Adjust bots every ~60 ticks (3 seconds)
    this.botAdjustTimer++;
    if (this.botAdjustTimer >= 60) {
      this.botAdjustTimer = 0;
      for (const room of this.rooms.values()) {
        room.adjustBots();
      }
    }

    // Build minimap summary every 20 ticks (~1s) — skip empty rooms
    let minimapData = null;
    if (this.tickCount % 20 === 0) {
      minimapData = {};
      for (const [key, room] of this.rooms) {
        const roaches = [];
        for (const r of room.roaches) {
          if (!r.isDead) {
            roaches.push({
              x: Math.round(r.x),
              y: Math.round(r.y),
              p: r.isPlayer ? 1 : 0,
              id: r.isPlayer ? r.id : undefined,
            });
          }
        }
        const bots = [];
        for (const b of room.houseBots) {
          bots.push({ x: Math.round(b.x), y: Math.round(b.y) });
        }
        if (roaches.length > 0 || bots.length > 0) {
          minimapData[key] = { roaches, bots };
        }
      }
    }

    // Broadcast tick to all players
    for (const [id, player] of this.players) {
      const room = this.rooms.get(player.room);
      if (!room) continue;

      const roomEvents = allEvents.filter(e =>
        e.room === player.room || e.playerId === id || e.victimId === id || e.stomperId === id
      );

      // Collect other players' cursor positions in same room
      const cursors = [];
      for (const [otherId, other] of this.players) {
        if (other.room === player.room && otherId !== id
            && Number.isFinite(other.cursorX) && Number.isFinite(other.cursorY)
            && other.cursorX >= 0 && other.cursorY >= 0) {
          cursors.push({
            id: otherId,
            x: other.cursorX,
            y: other.cursorY,
            bootScale: getBootScale(other.upgrades.bootSize),
          });
        }
      }

      const tickMsg = {
        type: 'tick',
        tick: this.tickCount,
        room: room.serialize(),
        motel: this.motel.serialize(),
        motelProgress: this.motel.getSavingProgress(id),
        events: roomEvents,
        cursors,
        you: {
          id,
          balance: player.roach.balance,
          banked: player.bankedBalance,
          hp: Math.round(player.roach.hp * 10) / 10,
          baseHp: BASE_HP,
          isPaid: player.isPaid,
          lastInputSeq: player.roach.lastInputSeq,
          healCount: player.roach.healCount,
          upgrades: { ...player.upgrades },
          stompCooldown: getStompCooldownForLevel(player.upgrades.rateOfFire),
          walletAddress: player.walletAddress,
          linkedIdentity: player.linkedIdentity,
          totalKills: player.totalKills || 0,
        },
      };
      if (minimapData) {
        tickMsg.minimap = minimapData;
      }
      if (this.leaderboardTimer === 0 && this.leaderboardCache.length > 0) {
        tickMsg.leaderboard = this.leaderboardCache;
      }
      this.send(player.ws, tickMsg);
    }
  }

  transitionPlayer(playerId, fromRoom, toRoom, direction) {
    const player = this.players.get(playerId);
    if (!player) return;

    const oldRoom = this.rooms.get(fromRoom);
    const newRoom = this.rooms.get(toRoom);
    if (!oldRoom || !newRoom) return;

    // Remove from old room
    const idx = oldRoom.roaches.indexOf(player.roach);
    if (idx > -1) oldRoom.roaches.splice(idx, 1);

    // Position on opposite edge
    switch (direction) {
      case 'left': player.roach.x = CONTAINER_WIDTH - ROACH_WIDTH - 10; break;
      case 'right': player.roach.x = 10; break;
      case 'up': player.roach.y = CONTAINER_HEIGHT - ROACH_HEIGHT - 10; break;
      case 'down': player.roach.y = 10; break;
    }

    // Add to new room
    newRoom.roaches.push(player.roach);
    player.room = toRoom;

    // Send room_enter with full snapshot
    this.send(player.ws, {
      type: 'room_enter',
      room: toRoom,
      snapshot: newRoom.serialize(),
      motel: this.motel.serialize(),
    });
  }

  async saveSessions() {
    const sessions = [];
    const now = Date.now();
    for (const [, player] of this.players) {
      if (!player.token || !player.isPaid) continue;
      sessions.push({
        playerId: player.token,
        room: player.room,
        x: player.roach.x,
        y: player.roach.y,
        balance: player.roach.balance,
        hp: player.roach.hp,
        timestamp: now,
      });
    }
    if (sessions.length > 0) {
      await db.bulkUpdateSessions(sessions);
    }
  }

  markPlayerPaid(playerToken, walletAddress = null) {
    for (const [, player] of this.players) {
      if (player.token === playerToken) {
        player.isPaid = true;
        if (walletAddress) {
          player.walletAddress = walletAddress;
        }
        this.send(player.ws, {
          type: 'payment_verified',
          isPaid: true,
          walletAddress: player.walletAddress || null,
        });
        break;
      }
    }
  }

  send(ws, msg) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(msg));
    }
  }
}
