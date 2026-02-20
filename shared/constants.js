// Shared constants between server and client
export const TICK_RATE = 50; // ms per tick (20 TPS)
export const TICKS_PER_SEC = 1000 / TICK_RATE;

export const CONTAINER_WIDTH = 600;
export const CONTAINER_HEIGHT = 400;

export const ROACH_WIDTH = 40;
export const ROACH_HEIGHT = 40;
export const BOOT_WIDTH = 115;
export const BOOT_HEIGHT = 127;
export const BOT_WIDTH = 92;
export const BOT_HEIGHT = 101;

export const GRID_SIZE = 3; // 3x3 room grid

export const STOMP_COOLDOWN = 200; // ms
export const HEAL_COST = 10;
export const MAX_HP = 2; // kept for reference but no longer a hard cap during play
export const BASE_HP = 2; // HP decays back toward this value
export const HP_DECAY_RATE = 1 / 3; // 1 HP lost per 3 seconds when above BASE_HP
export const DEATH_PENALTY = 0.9; // lose 90% of balance
export const KILL_REWARD = 0.9; // gain 90% of victim's balance
export const INCOME_RATE = 0.10; // 0.10 $ROACH per second per roach
export const MAX_ROACHES_PER_ROOM = 10;

export const PLAYER_BASE_SPEED = 3.125;
export const NPC_BASE_SPEED = 3;
export const WEALTH_SPEED_PENALTY_MAX = 1.5;
export const WEALTH_SPEED_PENALTY_RATE = 0.08;
export const MIN_SPEED = 0.8;

export const MOTEL_SPAWN_INTERVAL = 0; // no downtime between motel spawns
export const MOTEL_STAY_DURATION = 12000; // active for 12s before relocating
export const MOTEL_SAVE_TIME = 2; // seconds to bank (reduced from 5s)
export const MOTEL_SIZE = 240;

export const BOT_STOMP_COOLDOWN_MIN = 600;
export const BOT_STOMP_COOLDOWN_RANGE = 300;
export const BOTS_PER_WEALTH = 50; // 1 bot per 50 $ROACH of room wealth
export const MAX_BOTS_PER_ROOM = 8;
export const STOMP_AOE_RADIUS = 69; // AoE splash damage radius
export const STOMP_AOE_DAMAGE = 1; // 1 HP splash to nearby roaches

export const UPGRADE_DEFS = Object.freeze({
  bootSize: Object.freeze({
    label: 'Boot Size',
    maxLevel: 80,
    baseCost: 5,
    costMultiplier: 1.12,
  }),
  multiStomp: Object.freeze({
    label: 'Multi-stomp',
    maxLevel: 40,
    baseCost: 20,
    costMultiplier: 1.15,
  }),
  rateOfFire: Object.freeze({
    label: 'Rate-of-fire',
    maxLevel: 120,
    baseCost: 7.5,
    costMultiplier: 1.1,
  }),
  goldMagnet: Object.freeze({
    label: 'Gold Attraction',
    maxLevel: 160,
    baseCost: 6,
    costMultiplier: 1.11,
  }),
  wallBounce: Object.freeze({
    label: 'Wall Bounce',
    maxLevel: 60,
    baseCost: 10,
    costMultiplier: 1.12,
  }),
  idleIncome: Object.freeze({
    label: 'Idle Income',
    maxLevel: 160,
    baseCost: 8,
    costMultiplier: 1.11,
  }),
  shellArmor: Object.freeze({
    label: 'Shell Armor',
    maxLevel: 90,
    baseCost: 12,
    costMultiplier: 1.12,
  }),
});

export const UPGRADE_ORDER = Object.freeze([
  'bootSize',
  'multiStomp',
  'rateOfFire',
  'goldMagnet',
  'wallBounce',
  'idleIncome',
  'shellArmor',
]);

export function createDefaultUpgrades() {
  return {
    bootSize: 0,
    multiStomp: 0,
    rateOfFire: 0,
    goldMagnet: 0,
    wallBounce: 0,
    idleIncome: 0,
    shellArmor: 0,
  };
}

export function clampUpgradeLevel(upgradeKey, level) {
  const def = UPGRADE_DEFS[upgradeKey];
  if (!def) return 0;
  const parsed = Number.isFinite(level) ? level : Number(level);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(def.maxLevel, Math.floor(parsed)));
}

export function sanitizeUpgrades(raw) {
  const clean = createDefaultUpgrades();
  if (!raw || typeof raw !== 'object') return clean;
  for (const key of UPGRADE_ORDER) {
    clean[key] = clampUpgradeLevel(key, raw[key]);
  }
  return clean;
}

export function getUpgradeCost(upgradeKey, currentLevel) {
  const def = UPGRADE_DEFS[upgradeKey];
  if (!def) return Infinity;
  const level = clampUpgradeLevel(upgradeKey, currentLevel);
  const cost = def.baseCost * Math.pow(def.costMultiplier, level);
  return Math.round(cost * 100) / 100;
}

export function getBootScale(level) {
  const clamped = clampUpgradeLevel('bootSize', level);
  return Math.min(5, 1 + clamped * 0.022);
}

export function getStompCooldownForLevel(level) {
  const clamped = clampUpgradeLevel('rateOfFire', level);
  const speedFactor = 1 + clamped * 0.07 + clamped * clamped * 0.0015;
  const reduced = STOMP_COOLDOWN / speedFactor;
  return Math.max(30, Math.round(reduced));
}

export function getMultiStompOffsets(level, bootWidth = BOOT_WIDTH, bootHeight = BOOT_HEIGHT) {
  const clamped = clampUpgradeLevel('multiStomp', level);
  if (clamped <= 0) return [];

  const xStep = bootWidth * 0.52;
  const yStep = bootHeight * 0.44;
  const pairCount = Math.min(
    16,
    Math.max(1, Math.floor((clamped + 1) / 2))
  );
  const pairPatterns = [
    [{ rx: -1, ry: 0 }, { rx: 1, ry: 0 }],
    [{ rx: 0, ry: -1 }, { rx: 0, ry: 1 }],
    [{ rx: -1, ry: -1 }, { rx: 1, ry: -1 }],
    [{ rx: -1, ry: 1 }, { rx: 1, ry: 1 }],
    [{ rx: -2, ry: 0 }, { rx: 2, ry: 0 }],
    [{ rx: 0, ry: -2 }, { rx: 0, ry: 2 }],
    [{ rx: -2, ry: -1 }, { rx: 2, ry: -1 }],
    [{ rx: -2, ry: 1 }, { rx: 2, ry: 1 }],
    [{ rx: -1, ry: -2 }, { rx: 1, ry: -2 }],
    [{ rx: -1, ry: 2 }, { rx: 1, ry: 2 }],
    [{ rx: -3, ry: 0 }, { rx: 3, ry: 0 }],
    [{ rx: 0, ry: -3 }, { rx: 0, ry: 3 }],
    [{ rx: -2, ry: -2 }, { rx: 2, ry: -2 }],
    [{ rx: -2, ry: 2 }, { rx: 2, ry: 2 }],
    [{ rx: -3, ry: -1 }, { rx: 3, ry: -1 }],
    [{ rx: -3, ry: 1 }, { rx: 3, ry: 1 }],
  ];
  const offsets = [];

  for (let i = 0; i < pairCount; i++) {
    const pair = pairPatterns[i];
    const ringScale = 1 + Math.floor(i / 4) * 0.35;
    for (const point of pair) {
      offsets.push({
        dx: point.rx * xStep * ringScale,
        dy: point.ry * yStep * ringScale,
      });
    }
  }

  return offsets;
}

export function getGoldAttractionMultiplier(level) {
  const clamped = clampUpgradeLevel('goldMagnet', level);
  return 1 + clamped * 0.35 + clamped * clamped * 0.012;
}

export function getIdleIncomePerSecond(level) {
  const clamped = clampUpgradeLevel('idleIncome', level);
  if (clamped <= 0) return 0;
  return clamped * 0.02 + clamped * clamped * 0.002;
}

export function getShellArmorDeathPenalty(level) {
  const clamped = clampUpgradeLevel('shellArmor', level);
  const reduction = Math.min(0.8, clamped * 0.008);
  return Math.max(0.05, DEATH_PENALTY * (1 - reduction));
}

export function getWallBounceStrength(level) {
  const clamped = clampUpgradeLevel('wallBounce', level);
  return 0.5 + Math.min(2, clamped * 0.04);
}
