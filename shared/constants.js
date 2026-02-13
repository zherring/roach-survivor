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
export const HEAL_COST = 1;
export const MAX_HP = 2;
export const DEATH_PENALTY = 0.9; // lose 90% of balance
export const KILL_REWARD = 0.9; // gain 90% of victim's balance
export const INCOME_RATE = 0.01; // $0.01 per second per roach
export const MAX_ROACHES_PER_ROOM = 10;

export const PLAYER_BASE_SPEED = 2.5;
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
export const BOTS_PER_WEALTH = 5; // 1 bot per $5 — more bots faster
export const MAX_BOTS_PER_ROOM = 8;
export const STOMP_AOE_RADIUS = 69; // AoE splash damage radius
export const STOMP_AOE_DAMAGE = 1; // 1 HP splash to nearby roaches
