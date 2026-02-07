import {
  CONTAINER_WIDTH, CONTAINER_HEIGHT, ROACH_WIDTH, ROACH_HEIGHT,
  BOOT_WIDTH, BOOT_HEIGHT, MAX_ROACHES_PER_ROOM, INCOME_RATE,
  TICKS_PER_SEC, KILL_REWARD, DEATH_PENALTY, STOMP_COOLDOWN,
  BOTS_PER_WEALTH, MAX_BOTS_PER_ROOM, GRID_SIZE, MAX_HP, HEAL_COST,
} from '../shared/constants.js';
import { Roach } from './roach.js';
import { HouseBot } from './house-bot.js';

export class Room {
  constructor(key) {
    this.key = key;
    this.roaches = [];
    this.houseBots = [];
    this.pendingStomps = []; // queued from player input
  }

  addNpcRoaches(count) {
    for (let i = 0; i < count; i++) {
      this.roaches.push(new Roach(false, Math.random() * 3));
    }
  }

  getRoomWealth() {
    let total = 0;
    for (const r of this.roaches) total += r.balance;
    return total;
  }

  adjustBots() {
    // Always at least 1 bot per room, more with wealth
    const wealthBots = Math.floor(this.getRoomWealth() / BOTS_PER_WEALTH);
    const target = Math.min(Math.max(1, wealthBots), MAX_BOTS_PER_ROOM);
    while (this.houseBots.length < target) {
      this.houseBots.push(new HouseBot());
    }
    while (this.houseBots.length > target) {
      this.houseBots.pop();
    }
  }

  simulate(now) {
    const events = [];
    const dt = 1 / TICKS_PER_SEC;

    // Apply client-reported positions for player roaches
    for (const roach of this.roaches) {
      if (roach.isPlayer) roach.applyClientState();
    }

    // Update all roaches
    for (const roach of this.roaches) {
      roach.update(dt, this.houseBots);
    }

    // Process player stomps
    for (const stomp of this.pendingStomps) {
      const stompEvents = this.resolveStomp(stomp);
      events.push(...stompEvents);
    }
    this.pendingStomps = [];

    // Update house bots
    for (const bot of this.houseBots) {
      const botEvents = bot.update(now, this.roaches);
      events.push(...botEvents);
    }

    // Handle player deaths from bot kills — respawn after delay
    for (const evt of events) {
      if (evt.type === 'bot_kill') {
        const victim = this.roaches.find(r => r.id === evt.victimId);
        if (victim && victim.isPlayer) {
          // Respawn player immediately (they keep 10% balance)
          setTimeout(() => {
            victim.respawn();
          }, 500);
        } else if (victim && !victim.isPlayer) {
          // Schedule NPC respawn
          setTimeout(() => {
            const idx = this.roaches.indexOf(victim);
            if (idx > -1) this.roaches.splice(idx, 1);
            // Respawn after 5-10s
            setTimeout(() => {
              if (this.roaches.filter(r => !r.isPlayer).length < MAX_ROACHES_PER_ROOM) {
                this.roaches.push(new Roach(false, Math.random() * 3));
              }
            }, 5000 + Math.random() * 5000);
          }, 500);
        }
      }
    }

    // Passive income
    const incomePerTick = INCOME_RATE / TICKS_PER_SEC;
    for (const roach of this.roaches) {
      if (!roach.isDead) {
        roach.balance += incomePerTick;
      }
    }

    // Spawn NPCs if needed (rarely)
    if (Math.random() < 0.01) {
      const npcCount = this.roaches.filter(r => !r.isPlayer).length;
      if (npcCount < MAX_ROACHES_PER_ROOM) {
        this.roaches.push(new Roach(false, Math.random() * 3));
      }
    }

    return events;
  }

  resolveStomp(stomp) {
    const { playerId, x, y, seq } = stomp;
    const events = [];

    // Boot hitbox (same as prototype)
    const bootLeft = x - BOOT_WIDTH / 2;
    const bootRight = x + BOOT_WIDTH / 2;
    const bootTop = y - BOOT_HEIGHT * 0.8;
    const bootBottom = y + BOOT_HEIGHT * 0.2;
    let hitAny = false;

    for (const roach of this.roaches) {
      if (roach.id === playerId || roach.isDead) continue;

      const cx = roach.x + ROACH_WIDTH / 2;
      const cy = roach.y + ROACH_HEIGHT / 2;
      if (cx >= bootLeft && cx <= bootRight && cy >= bootTop && cy <= bootBottom) {
        hitAny = true;
        const killed = roach.hit();

        if (killed) {
          const reward = roach.balance * KILL_REWARD;
          // Find stomper and credit them
          const stomper = this.roaches.find(r => r.id === playerId);
          if (stomper) stomper.balance += reward;

          events.push({
            type: 'stomp_kill',
            stomperId: playerId,
            victimId: roach.id,
            reward,
            x, y,
          });

          roach.die();
          // Schedule NPC removal and respawn
          if (!roach.isPlayer) {
            setTimeout(() => {
              const idx = this.roaches.indexOf(roach);
              if (idx > -1) this.roaches.splice(idx, 1);
              setTimeout(() => {
                if (this.roaches.filter(r => !r.isPlayer).length < MAX_ROACHES_PER_ROOM) {
                  this.roaches.push(new Roach(false, Math.random() * 3));
                }
              }, 5000 + Math.random() * 5000);
            }, 500);
          } else {
            // Player killed another player!
            const lost = roach.balance;
            roach.balance *= (1 - DEATH_PENALTY);
            setTimeout(() => roach.respawn(), 500);
            events.push({
              type: 'player_death',
              victimId: roach.id,
              killerId: playerId,
              lost,
            });
          }
        } else {
          events.push({
            type: 'stomp_hit',
            stomperId: playerId,
            victimId: roach.id,
            hp: roach.hp,
            x, y,
          });
        }
        break; // one hit per stomp
      }
    }

    if (!hitAny) {
      // Scatter nearby
      const bootCenterX = x;
      const bootCenterY = y - BOOT_HEIGHT * 0.3;
      for (const roach of this.roaches) {
        if (roach.isDead) continue;
        const dx = (roach.x + ROACH_WIDTH / 2) - bootCenterX;
        const dy = (roach.y + ROACH_HEIGHT / 2) - bootCenterY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 80) {
          roach.scatter(bootCenterX, bootCenterY);
        }
      }
      events.push({ type: 'stomp_miss', stomperId: playerId, x, y });
    }

    return events;
  }

  // Check if a player roach has crossed a room edge. Returns direction or null.
  checkTransition(roach) {
    const [cx, cy] = this.key.split(',').map(Number);
    if (roach.x < -5 && cx > 0) return { dir: 'left', nx: cx - 1, ny: cy };
    if (roach.x > CONTAINER_WIDTH + 5 && cx < GRID_SIZE - 1) return { dir: 'right', nx: cx + 1, ny: cy };
    if (roach.y < -5 && cy > 0) return { dir: 'up', nx: cx, ny: cy - 1 };
    if (roach.y > CONTAINER_HEIGHT + 5 && cy < GRID_SIZE - 1) return { dir: 'down', nx: cx, ny: cy + 1 };

    // Clamp at grid edges
    if (roach.x < -5 && cx === 0) { roach.x = -5; roach.vx *= -0.5; }
    if (roach.x > CONTAINER_WIDTH + 5 && cx === GRID_SIZE - 1) { roach.x = CONTAINER_WIDTH + 5; roach.vx *= -0.5; }
    if (roach.y < -5 && cy === 0) { roach.y = -5; roach.vy *= -0.5; }
    if (roach.y > CONTAINER_HEIGHT + 5 && cy === GRID_SIZE - 1) { roach.y = CONTAINER_HEIGHT + 5; roach.vy *= -0.5; }

    return null;
  }

  serialize() {
    return {
      key: this.key,
      roaches: this.roaches.map(r => r.serialize()),
      bots: this.houseBots.map(b => b.serialize()),
    };
  }
}
