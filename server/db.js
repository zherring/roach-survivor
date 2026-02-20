import pg from 'pg';
import { randomUUID } from 'crypto';

const SESSION_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

let pool;

async function initDB() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  const dbUrl = process.env.DATABASE_URL;
  const useSSL = !dbUrl.includes('localhost') && !dbUrl.includes('sslmode=disable');

  pool = new pg.Pool({
    connectionString: dbUrl,
    ssl: useSSL ? { rejectUnauthorized: false } : false,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      banked_balance DOUBLE PRECISION DEFAULT 0,
      total_kills INTEGER DEFAULT 0,
      boot_size_level INTEGER DEFAULT 0,
      multi_stomp_level INTEGER DEFAULT 0,
      rate_of_fire_level INTEGER DEFAULT 0,
      gold_magnet_level INTEGER DEFAULT 0,
      wall_bounce_level INTEGER DEFAULT 0,
      idle_income_level INTEGER DEFAULT 0,
      shell_armor_level INTEGER DEFAULT 0,
      platform_type TEXT DEFAULT NULL,
      platform_id TEXT DEFAULT NULL,
      created_at BIGINT NOT NULL,
      last_seen BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      player_id TEXT PRIMARY KEY REFERENCES players(id),
      room TEXT NOT NULL,
      position_x DOUBLE PRECISION,
      position_y DOUBLE PRECISION,
      balance DOUBLE PRECISION DEFAULT 0,
      hp INTEGER DEFAULT 2,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at);
    CREATE INDEX IF NOT EXISTS idx_players_platform ON players (platform_type, platform_id);
  `);

  // Migration: hp column INTEGER -> DOUBLE PRECISION for fractional decay
  await pool.query(`
    ALTER TABLE sessions ALTER COLUMN hp TYPE DOUBLE PRECISION;
  `).catch(() => { /* already migrated or column doesn't exist */ });
}

const db = {
  async createPlayer(name) {
    const id = randomUUID();
    const now = Date.now();
    await pool.query(
      `INSERT INTO players (id, name, banked_balance, total_kills, created_at, last_seen)
       VALUES ($1, $2, 0, 0, $3, $4)`,
      [id, name, now, now]
    );
    return id;
  },

  async getPlayer(token) {
    const { rows } = await pool.query('SELECT * FROM players WHERE id = $1', [token]);
    return rows[0] || null;
  },

  async getSession(playerId) {
    const cutoff = Date.now() - SESSION_EXPIRY_MS;
    const { rows } = await pool.query(
      'SELECT * FROM sessions WHERE player_id = $1 AND updated_at > $2',
      [playerId, cutoff]
    );
    return rows[0] || null;
  },

  async updateSession(playerId, room, x, y, balance, hp) {
    await pool.query(
      `INSERT INTO sessions (player_id, room, position_x, position_y, balance, hp, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (player_id) DO UPDATE SET
         room = EXCLUDED.room, position_x = EXCLUDED.position_x, position_y = EXCLUDED.position_y,
         balance = EXCLUDED.balance, hp = EXCLUDED.hp, updated_at = EXCLUDED.updated_at`,
      [playerId, room, x, y, balance, hp, Date.now()]
    );
  },

  async updateBankedBalance(playerId, newTotal) {
    await pool.query(
      'UPDATE players SET banked_balance = $1, last_seen = $2 WHERE id = $3',
      [newTotal, Date.now(), playerId]
    );
  },

  async updateUpgrades(playerId, upgrades) {
    const bootSize = Number.isFinite(upgrades?.bootSize) ? upgrades.bootSize : 0;
    const multiStomp = Number.isFinite(upgrades?.multiStomp) ? upgrades.multiStomp : 0;
    const rateOfFire = Number.isFinite(upgrades?.rateOfFire) ? upgrades.rateOfFire : 0;
    const goldMagnet = Number.isFinite(upgrades?.goldMagnet) ? upgrades.goldMagnet : 0;
    const wallBounce = Number.isFinite(upgrades?.wallBounce) ? upgrades.wallBounce : 0;
    const idleIncome = Number.isFinite(upgrades?.idleIncome) ? upgrades.idleIncome : 0;
    const shellArmor = Number.isFinite(upgrades?.shellArmor) ? upgrades.shellArmor : 0;
    await pool.query(
      `UPDATE players
       SET boot_size_level = $1, multi_stomp_level = $2, rate_of_fire_level = $3,
           gold_magnet_level = $4, wall_bounce_level = $5, idle_income_level = $6,
           shell_armor_level = $7, last_seen = $8
       WHERE id = $9`,
      [bootSize, multiStomp, rateOfFire, goldMagnet, wallBounce, idleIncome, shellArmor, Date.now(), playerId]
    );
  },

  async incrementKills(playerId) {
    await pool.query(
      'UPDATE players SET total_kills = total_kills + 1, last_seen = $1 WHERE id = $2',
      [Date.now(), playerId]
    );
  },

  async bulkUpdateSessions(sessions) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const s of sessions) {
        await client.query(
          `INSERT INTO sessions (player_id, room, position_x, position_y, balance, hp, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (player_id) DO UPDATE SET
             room = EXCLUDED.room, position_x = EXCLUDED.position_x, position_y = EXCLUDED.position_y,
             balance = EXCLUDED.balance, hp = EXCLUDED.hp, updated_at = EXCLUDED.updated_at`,
          [s.playerId, s.room, s.x, s.y, s.balance, s.hp, s.timestamp]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async cleanStaleSessions() {
    const cutoff = Date.now() - SESSION_EXPIRY_MS;
    const result = await pool.query('DELETE FROM sessions WHERE updated_at < $1', [cutoff]);
    return result.rowCount;
  },

  async getPlayerByPlatform(platformType, platformId) {
    const { rows } = await pool.query(
      'SELECT * FROM players WHERE platform_type = $1 AND platform_id = $2',
      [platformType, platformId]
    );
    return rows[0] || null;
  },

  async linkPlatform(playerId, platformType, platformId) {
    await pool.query(
      'UPDATE players SET platform_type = $1, platform_id = $2, last_seen = $3 WHERE id = $4',
      [platformType, platformId, Date.now(), playerId]
    );
  },

  async getLeaderboard(limit = 20) {
    const { rows } = await pool.query(
      `SELECT id, name, banked_balance FROM players
       WHERE banked_balance > 0
       ORDER BY banked_balance DESC
       LIMIT $1`,
      [limit]
    );
    return rows;
  },

  async close() {
    if (pool) await pool.end();
  },
};

export { db, initDB };
