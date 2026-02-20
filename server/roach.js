import {
  CONTAINER_WIDTH, CONTAINER_HEIGHT, ROACH_WIDTH, ROACH_HEIGHT,
  PLAYER_BASE_SPEED, NPC_BASE_SPEED, WEALTH_SPEED_PENALTY_MAX,
  WEALTH_SPEED_PENALTY_RATE, MIN_SPEED, MAX_HP, BASE_HP, DEATH_PENALTY,
} from '../shared/constants.js';

let nextId = 0;

export class Roach {
  constructor(isPlayer = false, startBalance = 0, name = null) {
    this.id = isPlayer ? `p-${nextId++}` : `npc-${nextId++}`;
    this.x = Math.random() * (CONTAINER_WIDTH - ROACH_WIDTH) + ROACH_WIDTH / 2;
    this.y = Math.random() * (CONTAINER_HEIGHT - ROACH_HEIGHT) + ROACH_HEIGHT / 2;
    this.vx = (Math.random() - 0.5) * 2;
    this.vy = (Math.random() - 0.5) * 2;
    this.hp = BASE_HP;
    this.balance = startBalance;
    this.isPlayer = isPlayer;
    this.isDead = false;
    this.name = name;
    this.lastInputSeq = 0;
    this.healCount = 0;
    // Pending client state (position + velocity reported by client)
    this.pendingPos = null; // { x, y, vx, vy }
  }

  getSpeed() {
    const baseSpeed = this.isPlayer ? PLAYER_BASE_SPEED : NPC_BASE_SPEED;
    const penalty = Math.min(this.balance * WEALTH_SPEED_PENALTY_RATE, WEALTH_SPEED_PENALTY_MAX);
    return Math.max(baseSpeed - penalty, MIN_SPEED);
  }

  // For players: accept client-reported position with speed validation
  applyClientState() {
    if (!this.isPlayer || !this.pendingPos) return;

    const p = this.pendingPos;
    this.pendingPos = null;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.vx) || !Number.isFinite(p.vy)) {
      return;
    }
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y) || !Number.isFinite(this.vx) || !Number.isFinite(this.vy)) {
      this.respawn();
      this.vx = 0;
      this.vy = 0;
    }

    // Anti-cheat: clamp velocity to max allowed speed (with small tolerance)
    const maxSpeed = this.getSpeed() * 1.5; // tolerance for drunk steering spikes
    const mag = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
    if (Number.isFinite(mag) && mag > maxSpeed && mag > 0) {
      p.vx = (p.vx / mag) * maxSpeed;
      p.vy = (p.vy / mag) * maxSpeed;
    }

    // Anti-cheat: reject position if it moved further than possible in one tick
    const clampedX = Math.max(-15, Math.min(CONTAINER_WIDTH + 15, p.x));
    const clampedY = Math.max(-15, Math.min(CONTAINER_HEIGHT + 15, p.y));
    const dx = clampedX - this.x;
    const dy = clampedY - this.y;
    const posDist = Math.sqrt(dx * dx + dy * dy);
    const maxDist = maxSpeed * 10; // generous tolerance — client runs at 60fps, scatter/flee can spike
    if (Number.isFinite(posDist) && posDist > maxDist && posDist > 0) {
      // Clamp to max allowed distance in the reported direction
      this.x += (dx / posDist) * maxDist;
      this.y += (dy / posDist) * maxDist;
    } else {
      this.x = clampedX;
      this.y = clampedY;
    }
    this.vx = Number.isFinite(p.vx) ? p.vx : 0;
    this.vy = Number.isFinite(p.vy) ? p.vy : 0;

    this.x = Math.max(-15, Math.min(CONTAINER_WIDTH + 15, this.x));
    this.y = Math.max(-15, Math.min(CONTAINER_HEIGHT + 15, this.y));

    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) {
      this.respawn();
    }
  }

  update(dt, bots, cursors = []) {
    if (this.isDead) return;

    // Players are driven by client state, skip server-side physics for them
    if (this.isPlayer) return;

    // NPC drunk steering
    this.vx += (Math.random() - 0.5) * 0.3;
    this.vy += (Math.random() - 0.5) * 0.3;

    // NPC flee from player cursors (boot)
    for (const cursor of cursors) {
      const dx = this.x - cursor.x;
      const dy = this.y - cursor.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 50 && dist > 0) {
        const fleeForce = (50 - dist) / 50 * 0.3;
        this.vx += (dx / dist) * fleeForce;
        this.vy += (dy / dist) * fleeForce;
      }
    }

    // NPC flee from bots
    if (bots) {
      for (const bot of bots) {
        const dx = this.x - bot.x;
        const dy = this.y - bot.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 45 && dist > 0) {
          const fleeForce = (45 - dist) / 45 * 0.35;
          this.vx += (dx / dist) * fleeForce;
          this.vy += (dy / dist) * fleeForce;
        }
      }
    }

    // Clamp velocity
    const speed = this.getSpeed();
    const mag = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (mag > speed) {
      this.vx = (this.vx / mag) * speed;
      this.vy = (this.vy / mag) * speed;
    }

    // Move
    this.x += this.vx;
    this.y += this.vy;

    // Wall bounce
    if (this.x < 5 || this.x > CONTAINER_WIDTH - ROACH_WIDTH - 5) {
      this.vx *= -1;
      this.x = Math.max(5, Math.min(CONTAINER_WIDTH - ROACH_WIDTH - 5, this.x));
    }
    if (this.y < 5 || this.y > CONTAINER_HEIGHT - ROACH_HEIGHT - 5) {
      this.vy *= -1;
      this.y = Math.max(5, Math.min(CONTAINER_HEIGHT - ROACH_HEIGHT - 5, this.y));
    }
  }

  hit() {
    this.hp--;
    return this.hp <= 0;
  }

  die() {
    this.isDead = true;
    this.vx = 0;
    this.vy = 0;
  }

  respawn() {
    this.x = Math.random() * (CONTAINER_WIDTH - 20) + 10;
    this.y = Math.random() * (CONTAINER_HEIGHT - 20) + 10;
    this.hp = BASE_HP;
    this.isDead = false;
    this.vx = (Math.random() - 0.5) * 2;
    this.vy = (Math.random() - 0.5) * 2;
  }

  scatter(fromX, fromY) {
    if (this.isDead) return;
    const dx = this.x - fromX;
    const dy = this.y - fromY;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    this.vx += (dx / dist) * 3;
    this.vy += (dy / dist) * 3;
  }

  serialize() {
    return {
      id: this.id,
      x: Math.round(this.x * 10) / 10,
      y: Math.round(this.y * 10) / 10,
      vx: Math.round(this.vx * 100) / 100,
      vy: Math.round(this.vy * 100) / 100,
      hp: Math.round(this.hp * 10) / 10,
      balance: Math.round(this.balance * 100) / 100,
      dead: this.isDead,
      isPlayer: this.isPlayer,
      name: this.name,
      lastInputSeq: this.lastInputSeq,
    };
  }
}
