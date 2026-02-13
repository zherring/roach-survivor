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
      incrementKills: this.db.prepare(
        'UPDATE players SET total_kills = total_kills + 1, last_seen = ? WHERE id = ?'
      ),
      cleanSessions: this.db.prepare(
        'DELETE FROM sessions WHERE updated_at < ?'
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

  close() {
    this.db.close();
  }
}

export const db = new RoachDB();
