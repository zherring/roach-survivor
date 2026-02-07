import {
  TICK_RATE, GRID_SIZE, CONTAINER_WIDTH, CONTAINER_HEIGHT,
  ROACH_WIDTH, ROACH_HEIGHT, STOMP_COOLDOWN, HEAL_COST, MAX_HP,
} from '../shared/constants.js';
import { Room } from './room.js';
import { Roach } from './roach.js';
import { Motel } from './motel.js';

const ADJECTIVES = ['Speedy', 'Sneaky', 'Giant', 'Tiny', 'Stinky', 'Slimy', 'Crunchy', 'Greasy', 'Fuzzy', 'Crusty'];
const NOUNS = ['Roach', 'Bug', 'Crawler', 'Scuttler', 'Skitter', 'Creeper', 'Muncher', 'Nibbler', 'Dasher', 'Lurker'];

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

    switch (msg.type) {
      case 'input': {
        // Client sends its own position + velocity; server validates and accepts
        player.roach.pendingPos = { x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy };
        player.roach.lastInputSeq = msg.seq;
        break;
      }
      case 'stomp': {
        const now = Date.now();
        if (now - player.lastStomp < STOMP_COOLDOWN) break;
        player.lastStomp = now;
        const room = this.rooms.get(player.room);
        if (room) {
          room.pendingStomps.push({
            playerId,
            x: msg.x,
            y: msg.y,
            seq: msg.seq,
          });
        }
        break;
      }
      case 'heal': {
        const roach = player.roach;
        if (roach.hp >= MAX_HP || roach.balance < HEAL_COST) break;
        roach.balance -= HEAL_COST;
        roach.hp = Math.min(roach.hp + 1, MAX_HP);
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
      const events = room.simulate(now);
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

      this.send(player.ws, {
        type: 'tick',
        tick: this.tickCount,
        room: room.serialize(),
        motel: this.motel.serialize(),
        motelProgress: this.motel.getSavingProgress(id),
        events: roomEvents,
        you: {
          id,
          balance: player.roach.balance,
          banked: player.bankedBalance,
          hp: player.roach.hp,
          lastInputSeq: player.roach.lastInputSeq,
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
