import {
  TICK_RATE, GRID_SIZE, CONTAINER_WIDTH, CONTAINER_HEIGHT,
  ROACH_WIDTH, ROACH_HEIGHT, STOMP_COOLDOWN, HEAL_COST, MAX_HP,
} from '../shared/constants.js';
import { Room } from './room.js';
import { Roach } from './roach.js';
import { Motel } from './motel.js';

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

export class GameServer {
  constructor() {
    this.rooms = new Map();
    this.players = new Map(); // playerId -> { ws, roach, room, bankedBalance, lastStomp }
    this.motel = new Motel();
    this.tickCount = 0;
    this.botAdjustTimer = 0;

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

  start() {
    setInterval(() => this.tick(), TICK_RATE);
    console.log(`Game server started: ${GRID_SIZE}x${GRID_SIZE} grid, ${TICK_RATE}ms tick`);
  }

  addPlayer(ws) {
    const name = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]} ${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;
    const roomKey = '1,1'; // Center room
    const room = this.rooms.get(roomKey);
    const roach = new Roach(true, 0, name);
    room.roaches.push(roach);

    const player = {
      ws,
      roach,
      room: roomKey,
      bankedBalance: 0,
      lastStomp: 0,
      lastHeal: 0,
      cursorX: INVALID_CURSOR,
      cursorY: INVALID_CURSOR,
      msgCount: 0,
      msgWindowStart: Date.now(),
    };
    this.players.set(roach.id, player);

    // Send welcome with full snapshot
    this.send(ws, {
      type: 'welcome',
      id: roach.id,
      name,
      room: roomKey,
      snapshot: room.serialize(),
      motel: this.motel.serialize(),
      gridSize: GRID_SIZE,
    });

    console.log(`Player joined: ${name} (${roach.id}) in room ${roomKey}`);
    return roach.id;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;

    const room = this.rooms.get(player.room);
    if (room) {
      const idx = room.roaches.indexOf(player.roach);
      if (idx > -1) room.roaches.splice(idx, 1);
    }

    console.log(`Player left: ${player.roach.name} (${playerId})`);
    this.players.delete(playerId);
  }

  handleMessage(playerId, msg) {
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
        if (now - player.lastStomp < STOMP_COOLDOWN) break;
        player.lastStomp = now;
        const room = this.rooms.get(player.room);
        if (room) {
          room.pendingStomps.push({
            playerId,
            x: stomp.x,
            y: stomp.y,
            seq: stomp.seq,
          });
        }
        break;
      }
      case 'heal': {
        const healNow = Date.now();
        if (healNow - player.lastHeal < HEAL_COOLDOWN) break;
        const roach = player.roach;
        if (roach.hp >= MAX_HP || roach.balance < HEAL_COST) break;
        player.lastHeal = healNow;
        roach.balance -= HEAL_COST;
        roach.hp = Math.min(roach.hp + 1, MAX_HP);
        roach.healCount++;
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
        const transition = room.checkTransition(roach);
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
        }
      }
      allEvents.push(evt);
    }

    // Adjust bots every ~60 ticks (3 seconds)
    this.botAdjustTimer++;
    if (this.botAdjustTimer >= 60) {
      this.botAdjustTimer = 0;
      for (const room of this.rooms.values()) {
        room.adjustBots();
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
          cursors.push({ id: otherId, x: other.cursorX, y: other.cursorY });
        }
      }

      this.send(player.ws, {
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
          hp: player.roach.hp,
          lastInputSeq: player.roach.lastInputSeq,
          healCount: player.roach.healCount,
        },
      });
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

  send(ws, msg) {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify(msg));
    }
  }
}
