import {
  CONTAINER_WIDTH, CONTAINER_HEIGHT, BOT_WIDTH, BOT_HEIGHT,
  ROACH_WIDTH, ROACH_HEIGHT, BOT_STOMP_COOLDOWN_MIN, BOT_STOMP_COOLDOWN_RANGE,
  STOMP_AOE_RADIUS,
} from '../shared/constants.js';

let nextBotId = 0;

export class HouseBot {
  constructor() {
    this.id = `bot-${nextBotId++}`;
    this.x = Math.random() * (CONTAINER_WIDTH - BOT_WIDTH) + BOT_WIDTH / 2;
    this.y = Math.random() * (CONTAINER_HEIGHT - BOT_HEIGHT) + BOT_HEIGHT / 2;
    this.target = null;
    this.lastStomp = 0;
    this.stompCooldown = BOT_STOMP_COOLDOWN_MIN + Math.random() * BOT_STOMP_COOLDOWN_RANGE;
  }

  pickTarget(roaches) {
    const alive = roaches.filter(r => !r.isDead);
    if (alive.length === 0) { this.target = null; return; }

    // Weighted selection: richer roaches are WAY more likely to be targeted
    // Weight = balance + 0.1 (so even broke roaches have a small chance)
    const weights = alive.map(r => r.balance + 0.1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * totalWeight;
    for (let i = 0; i < alive.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { this.target = alive[i]; return; }
    }
    this.target = alive[alive.length - 1];
  }

  update(now, roaches) {
    // Re-target frequently — scan for juicier targets
    // Higher re-target rate if current target is poor
    const retargetChance = this.target ? Math.max(0.05, 0.2 - this.target.balance * 0.02) : 1;
    if (!this.target || this.target.isDead || Math.random() < retargetChance) {
      this.pickTarget(roaches);
    }

    if (this.target) {
      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 25) {
        // Faster pursuit for richer targets — they smell the money
        const baseSpeed = 3;
        const greedBoost = Math.min(this.target.balance * 0.15, 2);
        const speed = baseSpeed + greedBoost;
        this.x += (dx / dist) * speed + (Math.random() - 0.5) * 0.5;
        this.y += (dy / dist) * speed + (Math.random() - 0.5) * 0.5;
      }

      // Stomp when close
      if (dist < 50 && now - this.lastStomp > this.stompCooldown) {
        return this.stomp(now, roaches);
      }
    } else {
      // Wander
      this.x += (Math.random() - 0.5) * 3;
      this.y += (Math.random() - 0.5) * 3;
    }

    // Keep in bounds
    this.x = Math.max(BOT_WIDTH / 2, Math.min(CONTAINER_WIDTH - BOT_WIDTH / 2, this.x));
    this.y = Math.max(BOT_HEIGHT / 2, Math.min(CONTAINER_HEIGHT - BOT_HEIGHT / 2, this.y));

    return [];
  }

  stomp(now, roaches) {
    this.lastStomp = now;
    const events = [{ type: 'bot_stomp', botId: this.id, x: this.x, y: this.y }];
    const hitW = BOT_WIDTH * 0.7;
    const hitH = BOT_HEIGHT * 0.7;
    let directHitId = null; // track roach hit in direct phase to avoid AoE double-hit

    for (const roach of roaches) {
      if (roach.isDead) continue;
      const cx = roach.x + ROACH_WIDTH / 2;
      const cy = roach.y + ROACH_HEIGHT / 2;
      const inX = cx >= this.x - hitW / 2 && cx <= this.x + hitW / 2;
      const inY = cy >= this.y - hitH / 2 && cy <= this.y + hitH / 2;

      if (inX && inY) {
        directHitId = roach.id;
        const killed = roach.hit();
        if (killed) {
          const lost = roach.balance * 0.9;
          roach.balance *= 0.1;
          roach.die();
          events.push({
            type: 'bot_kill',
            botId: this.id,
            victimId: roach.id,
            lost,
            x: this.x,
            y: this.y,
          });
        } else {
          events.push({
            type: 'bot_hit',
            botId: this.id,
            victimId: roach.id,
            hp: roach.hp,
            x: this.x,
            y: this.y,
          });
        }
        break; // one hit per stomp
      }
    }

    // AoE gradient: closer = higher chance of taking damage
    for (const roach of roaches) {
      if (roach.isDead || roach.id === directHitId) continue;
      const cx = roach.x + ROACH_WIDTH / 2;
      const cy = roach.y + ROACH_HEIGHT / 2;
      const dx = cx - this.x;
      const dy = cy - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < STOMP_AOE_RADIUS && dist > 15) {
        // Gradient: 80% hit chance at center, 10% at edge
        const hitChance = 0.8 * (1 - dist / STOMP_AOE_RADIUS);
        if (Math.random() < hitChance) {
          const killed = roach.hit();
          if (killed) {
            const lost = roach.balance * 0.9;
            roach.balance *= 0.1;
            roach.die();
            events.push({ type: 'bot_kill', botId: this.id, victimId: roach.id, lost, x: roach.x, y: roach.y });
          } else {
            events.push({ type: 'bot_hit', botId: this.id, victimId: roach.id, hp: roach.hp, x: this.x, y: this.y });
          }
        }
        roach.scatter(this.x, this.y);
      } else if (dist < 100 && dist > 15) {
        roach.scatter(this.x, this.y);
      }
    }

    return events;
  }

  serialize() {
    return {
      id: this.id,
      x: Math.round(this.x * 10) / 10,
      y: Math.round(this.y * 10) / 10,
    };
  }
}
