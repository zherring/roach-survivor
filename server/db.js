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
      paid_account BOOLEAN DEFAULT FALSE,
      paid_at BIGINT DEFAULT NULL,
      wallet_address TEXT DEFAULT NULL,
      paid_amount DOUBLE PRECISION DEFAULT NULL,
      payment_tx_hash TEXT DEFAULT NULL,
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
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      tx_hash TEXT NOT NULL UNIQUE,
      amount_usdc DOUBLE PRECISION NOT NULL,
      chain_id INTEGER NOT NULL,
      from_address TEXT,
      verified_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paid_player_count INTEGER NOT NULL DEFAULT 0,
      updated_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payment_log (
      id SERIAL PRIMARY KEY,
      player_id TEXT NOT NULL REFERENCES players(id),
      tx_hash TEXT NOT NULL UNIQUE,
      amount_usdc DOUBLE PRECISION NOT NULL,
      chain_id INTEGER NOT NULL,
      from_address TEXT NOT NULL,
      recipient_address TEXT NOT NULL,
      verified_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions (updated_at);
    CREATE INDEX IF NOT EXISTS idx_players_platform ON players (platform_type, platform_id);
    CREATE INDEX IF NOT EXISTS idx_payments_tx_hash ON payments (tx_hash);
    CREATE INDEX IF NOT EXISTS idx_payment_log_tx_hash ON payment_log (tx_hash);
    CREATE INDEX IF NOT EXISTS idx_payment_log_player_id ON payment_log (player_id);
  `);

  // Migration: add paid_account column if it doesn't exist (for existing DBs)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE players ADD COLUMN paid_account BOOLEAN DEFAULT FALSE;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE players ADD COLUMN paid_at BIGINT DEFAULT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE players ADD COLUMN wallet_address TEXT DEFAULT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE players ADD COLUMN paid_amount DOUBLE PRECISION DEFAULT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE players ADD COLUMN payment_tx_hash TEXT DEFAULT NULL;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);

  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_players_payment_tx_hash ON players (payment_tx_hash)'
  );

  await pool.query(
    `INSERT INTO payment_config (id, paid_player_count, updated_at)
     VALUES (
       1,
       (SELECT COUNT(*)::INTEGER FROM players WHERE paid_account = TRUE),
       $1
     )
     ON CONFLICT (id) DO NOTHING`,
    [Date.now()]
  );
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

  async getPaidPlayerByWallet(walletAddress) {
    const normalized = typeof walletAddress === 'string' ? walletAddress.trim().toLowerCase() : '';
    if (!normalized) return null;
    const { rows } = await pool.query(
      `SELECT *
       FROM players
       WHERE paid_account = TRUE
         AND wallet_address IS NOT NULL
         AND lower(wallet_address) = $1
       ORDER BY paid_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [normalized]
    );
    return rows[0] || null;
  },

  async linkPlatform(playerId, platformType, platformId) {
    await pool.query(
      'UPDATE players SET platform_type = $1, platform_id = $2, last_seen = $3 WHERE id = $4',
      [platformType, platformId, Date.now(), playerId]
    );
  },

  async markPaid(playerId, {
    txHash,
    amountUsdc,
    chainId,
    fromAddress,
    recipientAddress,
    walletAddress,
  }) {
    const now = Date.now();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT paid_account FROM players WHERE id = $1 FOR UPDATE',
        [playerId]
      );
      if (!existing.rows[0]) {
        throw new Error('Player not found');
      }
      if (existing.rows[0].paid_account) {
        const countResult = await client.query(
          'SELECT paid_player_count FROM payment_config WHERE id = 1'
        );
        await client.query('COMMIT');
        return {
          alreadyPaid: true,
          paidCount: Number(countResult.rows[0]?.paid_player_count || 0),
        };
      }

      await client.query(
        `UPDATE players
         SET paid_account = TRUE, paid_at = $1, last_seen = $1,
             wallet_address = $2, paid_amount = $3, payment_tx_hash = $4
         WHERE id = $5`,
        [now, walletAddress || null, amountUsdc, txHash, playerId]
      );
      await client.query(
        `INSERT INTO payment_log (player_id, tx_hash, amount_usdc, chain_id, from_address, recipient_address, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [playerId, txHash, amountUsdc, chainId, fromAddress, recipientAddress, now]
      );
      // Legacy table kept for backward compatibility with existing scripts.
      await client.query(
        `INSERT INTO payments (player_id, tx_hash, amount_usdc, chain_id, from_address, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [playerId, txHash, amountUsdc, chainId, fromAddress, now]
      );
      const countResult = await client.query(
        `UPDATE payment_config
         SET paid_player_count = paid_player_count + 1, updated_at = $1
         WHERE id = 1
         RETURNING paid_player_count`,
        [now]
      );
      await client.query('COMMIT');
      return {
        alreadyPaid: false,
        paidCount: Number(countResult.rows[0]?.paid_player_count || 0),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async getPaidPlayerCount() {
    const { rows } = await pool.query('SELECT paid_player_count FROM payment_config WHERE id = 1');
    return Number(rows[0]?.paid_player_count || 0);
  },

  async isPaymentProcessed(txHash) {
    const { rows } = await pool.query(
      `SELECT 1
       FROM payment_log
       WHERE tx_hash = $1
       UNION ALL
       SELECT 1
       FROM payments
       WHERE tx_hash = $1
       LIMIT 1`,
      [txHash]
    );
    return rows.length > 0;
  },

  async close() {
    if (pool) await pool.end();
  },
};

export { db, initDB };
