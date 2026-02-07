// Shared constants between server and client
export const TICK_RATE = 50; // ms per tick (20 TPS)
export const TICKS_PER_SEC = 1000 / TICK_RATE;

export const CONTAINER_WIDTH = 600;
export const CONTAINER_HEIGHT = 400;

export const ROACH_WIDTH = 35;
export const ROACH_HEIGHT = 35;
export const BOOT_WIDTH = 100;
export const BOOT_HEIGHT = 110;
export const BOT_WIDTH = 80;
export const BOT_HEIGHT = 88;

export const GRID_SIZE = 3; // 3x3 room grid

export const STOMP_COOLDOWN = 200; // ms
export const HEAL_COST = 1;
export const MAX_HP = 3;
export const DEATH_PENALTY = 0.9; // lose 90% of balance
export const KILL_REWARD = 0.9; // gain 90% of victim's balance
export const INCOME_RATE = 0.01; // $0.01 per second per roach
export const MAX_ROACHES_PER_ROOM = 10;

export const PLAYER_BASE_SPEED = 2.5;
export const NPC_BASE_SPEED = 3;
export const WEALTH_SPEED_PENALTY_MAX = 1.5;
export const WEALTH_SPEED_PENALTY_RATE = 0.08;
export const MIN_SPEED = 0.8;

export const MOTEL_SPAWN_INTERVAL = 15000;
export const MOTEL_STAY_DURATION = 10000;
export const MOTEL_SAVE_TIME = 5; // seconds to bank
export const MOTEL_SIZE = 240;

export const BOT_STOMP_COOLDOWN_MIN = 800;
export const BOT_STOMP_COOLDOWN_RANGE = 400;
export const BOTS_PER_WEALTH = 10; // 1 bot per $10
export const MAX_BOTS_PER_ROOM = 5;
