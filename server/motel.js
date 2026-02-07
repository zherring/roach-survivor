import {
  CONTAINER_WIDTH, CONTAINER_HEIGHT, ROACH_WIDTH, ROACH_HEIGHT,
  MOTEL_SPAWN_INTERVAL, MOTEL_STAY_DURATION, MOTEL_SAVE_TIME, MOTEL_SIZE,
  GRID_SIZE,
} from '../shared/constants.js';

export class Motel {
  constructor() {
    this.room = null;
    this.x = 0;
    this.y = 0;
    this.active = false;
    this.nextSpawnTime = Date.now(); // spawn immediately on server start
    this.despawnTime = 0;
    // Track saving progress per player: playerId -> seconds accumulated
    this.savingProgress = new Map();
  }

  update(now, rooms) {
    if (this.active) {
      if (now >= this.despawnTime) {
        this.despawn();
        this.spawn(rooms); // keep a motel active at all times
      }
    } else {
      if (now >= this.nextSpawnTime) {
        this.spawn(rooms);
      }
    }

    // Check collisions for players in the motel room
    if (!this.active || !this.room) return [];
    const room = rooms.get(this.room);
    if (!room) return [];

    const events = [];
    const players = room.roaches.filter(r => r.isPlayer && !r.isDead);

    for (const player of players) {
      const px = player.x + ROACH_WIDTH / 2;
      const py = player.y + ROACH_HEIGHT / 2;
      const mx = this.x + MOTEL_SIZE / 2;
      const my = this.y + MOTEL_SIZE / 2;
      const dist = Math.sqrt((px - mx) ** 2 + (py - my) ** 2);
      const inside = dist < MOTEL_SIZE / 2;

      if (inside) {
        const progress = (this.savingProgress.get(player.id) || 0) + (1 / 20); // 20 TPS
        this.savingProgress.set(player.id, progress);

        if (progress >= MOTEL_SAVE_TIME) {
          // Bank!
          const banked = player.balance;
          events.push({
            type: 'bank',
            playerId: player.id,
            amount: banked,
          });
          this.savingProgress.delete(player.id);
          this.despawn();
          this.spawn(rooms); // instantly relocate after a successful bank
          return events;
        }
      } else {
        // Left motel — reset
        if (this.savingProgress.has(player.id)) {
          this.savingProgress.delete(player.id);
          events.push({ type: 'bank_cancel', playerId: player.id });
        }
      }
    }

    return events;
  }

  spawn(rooms) {
    // Pick random room from available rooms
    const roomKeys = Array.from(rooms.keys());
    if (roomKeys.length === 0) return;
    this.room = roomKeys[Math.floor(Math.random() * roomKeys.length)];
    this.x = 150 + Math.random() * 300;
    this.y = 80 + Math.random() * 200;
    this.active = true;
    this.despawnTime = Date.now() + MOTEL_STAY_DURATION;
    this.savingProgress.clear();
  }

  despawn() {
    this.active = false;
    this.room = null;
    this.nextSpawnTime = Date.now() + MOTEL_SPAWN_INTERVAL;
    this.savingProgress.clear();
  }

  getSavingProgress(playerId) {
    return this.savingProgress.get(playerId) || 0;
  }

  serialize() {
    if (!this.active) return null;
    return {
      room: this.room,
      x: this.x,
      y: this.y,
      active: true,
      despawnTime: this.despawnTime,
    };
  }
}
