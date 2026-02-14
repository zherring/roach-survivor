import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'roach.db');
const SESSION_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

class RoachDB {
  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this._initSchema();
    this._prepareStatements();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        banked_balance REAL DEFAULT 0,
        total_kills INTEGER DEFAULT 0,
        boot_size_level INTEGER DEFAULT 0,
        multi_stomp_level INTEGER DEFAULT 0,
        rate_of_fire_level INTEGER DEFAULT 0,
        gold_magnet_level INTEGER DEFAULT 0,
        wall_bounce_level INTEGER DEFAULT 0,
        idle_income_level INTEGER DEFAULT 0,
        shell_armor_level INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        player_id TEXT PRIMARY KEY,
        room TEXT NOT NULL,
        position_x REAL,
        position_y REAL,
        balance REAL DEFAULT 0,
        hp INTEGER DEFAULT 2,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (player_id) REFERENCES players(id)
      );
    `);

    // Backward-compatible migrations for pre-M6 databases.
    const columns = this.db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
    const addColumn = (name, ddl) => {
      if (!columns.includes(name)) {
        this.db.exec(ddl);
        columns.push(name);
      }
    };
    addColumn('boot_size_level', 'ALTER TABLE players ADD COLUMN boot_size_level INTEGER DEFAULT 0');
    addColumn('multi_stomp_level', 'ALTER TABLE players ADD COLUMN multi_stomp_level INTEGER DEFAULT 0');
    addColumn('rate_of_fire_level', 'ALTER TABLE players ADD COLUMN rate_of_fire_level INTEGER DEFAULT 0');
    addColumn('gold_magnet_level', 'ALTER TABLE players ADD COLUMN gold_magnet_level INTEGER DEFAULT 0');
    addColumn('wall_bounce_level', 'ALTER TABLE players ADD COLUMN wall_bounce_level INTEGER DEFAULT 0');
    addColumn('idle_income_level', 'ALTER TABLE players ADD COLUMN idle_income_level INTEGER DEFAULT 0');
    addColumn('shell_armor_level', 'ALTER TABLE players ADD COLUMN shell_armor_level INTEGER DEFAULT 0');
    // M7: platform identity columns
    addColumn('platform_type', 'ALTER TABLE players ADD COLUMN platform_type TEXT DEFAULT NULL');
    addColumn('platform_id', 'ALTER TABLE players ADD COLUMN platform_id TEXT DEFAULT NULL');
  }

  _prepareStatements() {
    this._stmts = {
      createPlayer: this.db.prepare(
        `INSERT INTO players (id, name, banked_balance, total_kills, created_at, last_seen)
         VALUES (?, ?, 0, 0, ?, ?)`
      ),
      getPlayer: this.db.prepare('SELECT * FROM players WHERE id = ?'),
      getSession: this.db.prepare(
        'SELECT * FROM sessions WHERE player_id = ? AND updated_at > ?'
      ),
      upsertSession: this.db.prepare(
        `INSERT INTO sessions (player_id, room, position_x, position_y, balance, hp, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(player_id) DO UPDATE SET
           room=excluded.room, position_x=excluded.position_x, position_y=excluded.position_y,
           balance=excluded.balance, hp=excluded.hp, updated_at=excluded.updated_at`
      ),
      updateBanked: this.db.prepare(
        'UPDATE players SET banked_balance = ?, last_seen = ? WHERE id = ?'
      ),
      updateUpgrades: this.db.prepare(
        `UPDATE players
         SET boot_size_level = ?, multi_stomp_level = ?, rate_of_fire_level = ?,
             gold_magnet_level = ?, wall_bounce_level = ?, idle_income_level = ?,
             shell_armor_level = ?, last_seen = ?
         WHERE id = ?`
      ),
      incrementKills: this.db.prepare(
        'UPDATE players SET total_kills = total_kills + 1, last_seen = ? WHERE id = ?'
      ),
      cleanSessions: this.db.prepare(
        'DELETE FROM sessions WHERE updated_at < ?'
      ),
      getPlayerByPlatform: this.db.prepare(
        'SELECT * FROM players WHERE platform_type = ? AND platform_id = ?'
      ),
      linkPlatform: this.db.prepare(
        'UPDATE players SET platform_type = ?, platform_id = ?, last_seen = ? WHERE id = ?'
      ),
    };
  }

  createPlayer(name) {
    const id = randomUUID();
    const now = Date.now();
    this._stmts.createPlayer.run(id, name, now, now);
    return id;
  }

  getPlayer(token) {
    return this._stmts.getPlayer.get(token) || null;
  }

  getSession(playerId) {
    return this._stmts.getSession.get(playerId, Date.now() - SESSION_EXPIRY_MS) || null;
  }

  updateSession(playerId, room, x, y, balance, hp) {
    this._stmts.upsertSession.run(playerId, room, x, y, balance, hp, Date.now());
  }

  updateBankedBalance(playerId, newTotal) {
    this._stmts.updateBanked.run(newTotal, Date.now(), playerId);
  }

  updateUpgrades(playerId, upgrades) {
    const bootSize = Number.isFinite(upgrades?.bootSize) ? upgrades.bootSize : 0;
    const multiStomp = Number.isFinite(upgrades?.multiStomp) ? upgrades.multiStomp : 0;
    const rateOfFire = Number.isFinite(upgrades?.rateOfFire) ? upgrades.rateOfFire : 0;
    const goldMagnet = Number.isFinite(upgrades?.goldMagnet) ? upgrades.goldMagnet : 0;
    const wallBounce = Number.isFinite(upgrades?.wallBounce) ? upgrades.wallBounce : 0;
    const idleIncome = Number.isFinite(upgrades?.idleIncome) ? upgrades.idleIncome : 0;
    const shellArmor = Number.isFinite(upgrades?.shellArmor) ? upgrades.shellArmor : 0;
    this._stmts.updateUpgrades.run(
      bootSize,
      multiStomp,
      rateOfFire,
      goldMagnet,
      wallBounce,
      idleIncome,
      shellArmor,
      Date.now(),
      playerId
    );
  }

  incrementKills(playerId) {
    this._stmts.incrementKills.run(Date.now(), playerId);
  }

  bulkUpdateSessions(sessions) {
    const tx = this.db.transaction((items) => {
      for (const s of items) {
        this._stmts.upsertSession.run(s.playerId, s.room, s.x, s.y, s.balance, s.hp, s.timestamp);
      }
    });
    tx(sessions);
  }

  cleanStaleSessions() {
    const result = this._stmts.cleanSessions.run(Date.now() - SESSION_EXPIRY_MS);
    return result.changes;
  }

  getPlayerByPlatform(platformType, platformId) {
    return this._stmts.getPlayerByPlatform.get(platformType, platformId) || null;
  }

  linkPlatform(playerId, platformType, platformId) {
    this._stmts.linkPlatform.run(platformType, platformId, Date.now(), playerId);
  }

  close() {
    this.db.close();
  }
}

export const db = new RoachDB();
