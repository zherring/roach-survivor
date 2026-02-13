# M5: Persistence & Reconnection

## Context
All game state is in-memory — disconnecting or restarting the server loses everything (banked balance, player name, position). This is the #1 frustration for real players and blocks M6 (upgrades) and M8 (crypto). This milestone adds SQLite persistence and session-based reconnection.

## Approach: SQLite via `better-sqlite3`
- Synchronous API — no async complexity, fits the tick-based architecture
- Single new dependency (project currently has only `ws`)
- WAL mode for concurrent reads/writes
- File-based — works anywhere Node runs

---

## Changes

### 1. NEW: `server/db.js` (~120 lines)
SQLite persistence layer:

**Schema:**
```sql
players (id TEXT PK, name TEXT, banked_balance REAL, total_kills INT, created_at INT, last_seen INT)
sessions (player_id TEXT PK FK, room TEXT, x REAL, y REAL, balance REAL, hp INT, updated_at INT)
```

**Key methods:**
- `createPlayer(name)` → returns UUID token
- `getPlayer(token)` → player record or null
- `getSession(playerId)` → session if <5 min old
- `updateSession(playerId, room, x, y, balance, hp)` — upsert
- `bulkUpdateSessions(sessions)` — batched in transaction (called from tick)
- `updateBankedBalance(playerId, amount)` — on bank events
- `incrementKills(playerId)` — on stomp kills
- `close()` — graceful shutdown

### 2. MODIFY: `server/index.js`
- Change connection handler: don't immediately call `addPlayer()`. Instead, wait for first message — if it's `{ type: 'reconnect', token }`, pass token to `addPlayer(ws, token)`. Otherwise call `addPlayer(ws)` with no token.
- Add `SIGTERM`/`SIGINT` handlers: call `gameServer.saveSessions()`, `db.close()`, then exit.

### 3. MODIFY: `server/game-server.js`
- `import { db } from './db.js'`
- `addPlayer(ws, reconnectToken = null)`:
  - If token provided → `db.getPlayer(token)` for name + banked balance, `db.getSession(token)` for room/position/balance/hp
  - If no token → generate name, `db.createPlayer(name)` for new token
  - Store `token` on the player object
  - Send token in `welcome` message + `restored: true/false` flag
- `removePlayer(playerId)`:
  - Before deleting, call `db.updateSession()` to save current state
  - Don't delete player record from DB — only from in-memory Map
- Bank event (line 242-248):
  - After updating `player.bankedBalance`, call `db.updateBankedBalance(player.token, amount)`
- Kill events:
  - Call `db.incrementKills(player.token)` when a player gets a kill
- New `saveSessions()` method:
  - Iterates all players, builds array, calls `db.bulkUpdateSessions()`
- In `tick()`:
  - Every 200 ticks (~10s), call `saveSessions()` for periodic persistence

### 4. MODIFY: `client/game.js`
- Add `let sessionToken = localStorage.getItem('roach_session_token');` near top
- In `connect()` → `ws.onopen`: if `sessionToken` exists, send `{ type: 'reconnect', token: sessionToken }`
- In `handleMessage` → `case 'welcome'`:
  - Store `msg.token` in localStorage: `localStorage.setItem('roach_session_token', msg.token)`
  - If `msg.restored`, show "Reconnected as [name]!" instead of the default welcome

### 5. MODIFY: `package.json`
- Add `"better-sqlite3": "^11.0.0"` to dependencies

---

## Testing
1. `npm install` to get better-sqlite3
2. `npm start` — verify server starts clean, creates `roach.db`
3. Open browser — verify new player gets token in localStorage
4. Bank some money → refresh page → verify "Reconnected" message, banked balance persists
5. Kill server (Ctrl+C) → restart → refresh → verify banked balance survives restart
6. Wait 6+ minutes → refresh → verify spawns fresh (center room) but banked balance kept
7. Open two browser tabs — verify independent sessions
