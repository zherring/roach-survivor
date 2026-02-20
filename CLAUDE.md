# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

$ROACH is a skill-based multiplayer browser game where players control roaches, stomp other roaches for points, and survive as long as possible. The game has a full Node.js multiplayer backend with PostgreSQL persistence, WebSocket networking, and a DOM-based client.

**Key docs** (read these before making architectural decisions):
- `ARCHITECTURE-ROACH-GAME.md` - Full architecture, protocol spec, milestone roadmap, current status
- `PRD-ROACH-GAME.md` - Game design, mechanics, tokenomics
- `AGENT-IMPLEMENTATION.md` - AI agent integration guide

## Running the Game

```bash
# Local development (requires PostgreSQL)
npm run dev    # creates db if needed, runs with --watch

# Production
npm start      # requires DATABASE_URL env var
```

The server serves static files from `client/` and runs WebSocket on the same port (default 3000).

**Legacy prototype**: `roach-prototype.html` is an older single-file prototype. The real game is the client/server architecture below.

## Architecture

### Stack
- **Server**: Node.js, `ws` (WebSocket), `pg` (PostgreSQL), zero framework
- **Client**: Vanilla JS, DOM-based rendering (not canvas), sprite-based visuals
- **Database**: PostgreSQL with players + sessions tables
- **Shared**: `shared/constants.js` - game tuning values used by both client and server

### File Map

```
server/
  index.js          # HTTP + WebSocket server entry point
  game-server.js    # Game loop (20 TPS), player management, message handling
  room.js           # Per-room physics, combat resolution, NPC spawning
  roach.js          # Entity class (movement, hit detection, anti-cheat)
  house-bot.js      # AI bot targeting and pursuit
  motel.js          # Banking system (motel spawn, collision, progress)
  db.js             # PostgreSQL persistence layer

client/
  game.js           # Client-side game logic, WebSocket connection, rendering
  index.html        # Game UI
  styles.css        # Pixel aesthetic styling

shared/
  constants.js      # All game tuning values (tick rate, grid size, economy, etc.)

smart-contracts/    # Foundry project for $ROACH ERC20 on Base
```

### Database Schema

**Players table**: id, name, banked_balance, total_kills, upgrade levels (7 types), platform identity, timestamps

**Sessions table**: player_id, room, position, balance, hp, updated_at (5-min expiry for reconnection)

### Networking

WebSocket protocol with flat message types:
- **Client -> Server**: `input` (position/velocity), `stomp`, `heal`, `buy_upgrade`, `reconnect`
- **Server -> Client**: `welcome` (full state), `tick` (room snapshot + events), `room_enter`, upgrade results
- Server ticks at 20 TPS, client movement is client-authoritative with server-side anti-cheat validation

### Key Game Mechanics

- **Economy**: Points-based. Passive income + kill rewards. Banking at Roach Motel (2s channel time)
- **Combat**: Boot stomp with AoE splash damage, multi-hit zones, wealth-weighted bot targeting
- **Movement**: Client-authoritative with drunk steering, wealth-based speed penalty
- **Upgrades**: 7 persistent upgrade types (bootSize, multiStomp, rateOfFire, goldMagnet, wallBounce, idleIncome, shellArmor)
- **Rooms**: 3x3 grid, edge-crossing transitions, per-room NPC/bot simulation
- **Death**: 90% balance loss (reduced by shellArmor), instant respawn

### Security

- Rate limiting (60 msg/sec per client)
- Server-side input validation and velocity clamping
- Position distance anti-cheat checks
- Path traversal protection on static file serving
- Heal cooldown enforced server-side

## Milestone Status

| Milestone | Status |
|-----------|--------|
| M1: Deploy & Share | DONE |
| M2: Visual Polish (sprites, VFX, prospector NPC) | DONE |
| M3: Sound Design | DONE |
| M4: Mobile Touch Controls | DONE |
| M5: Persistence & Reconnection (Postgres) | DONE |
| M6: Permanent Upgrades | DONE |
| M7: Miniapp Integration (Farcaster/Base) | NOT STARTED |
| M8: Agent API | NOT STARTED |
| M9: Crypto Integration (USDC save gate) | NOT STARTED |

See `ARCHITECTURE-ROACH-GAME.md` Part 2 for full milestone details.
