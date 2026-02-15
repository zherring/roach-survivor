# $ROACH Multiplayer Architecture

This document started as a proposal (see git history for the original draft). It now reflects what was actually built and the key decisions that diverged from the initial plan.

---

## Part 1: Architecture — What We Built vs. What Was Proposed

### Stack Decision
- **Proposed:** "Node/TS vs Go/Rust" — open question
- **Built:** Node.js (vanilla JS, no TypeScript), `ws` as sole dependency. Zero build step. `import.meta.dirname` (Node 24). Single process serves HTTP + WebSocket.

### Client Architecture
- **Proposed:** "Canvas-based game client"
- **Built:** DOM-based rendering (div elements with CSS sprites, transforms, filters). No `<canvas>`. This was a deliberate choice — DOM gives us CSS animations (splats, shockwaves, coin showers) for free and sprite tinting via CSS filters. Performance is fine at the current entity count.

### Movement & Prediction Model
- **Proposed:** "Clients send inputs, server resolves"
- **Built (after iteration):** **Client-authoritative movement** with server validation. Client applies WASD + drunk steering locally, sends position/velocity to server every 50ms. Server validates speed (clamps to `getSpeed() * 1.5`) and position distance (clamps jumps to `maxSpeed * 10`). Server only overrides on >50px error (respawn/teleport). This was changed from server-authoritative after the initial implementation felt janky — random drunk steering on server diverged from client's random values, causing constant reconciliation snaps.

### Combat & Economy
- **Proposed:** Server-authoritative stomps, 90% death penalty
- **Built:** Exactly as proposed, plus:
  - AoE gradient damage (probability falloff from stomp center, 81px radius — scaled up from original 60px with sprite size increase)
  - HP reduced to 2 (was 3 in PRD)
  - House bots have wealth-weighted targeting (`weight = balance + 0.1`)
  - Bot pursuit speed scales with target wealth (`3 + min(balance * 0.15, 2)`)
  - Combo kill VFX system (coin shower scales with consecutive kills within 1.5s)
  - Balance math fix: death penalty applied before `die()` so victims keep exactly 10%

### Room Grid
- **Proposed:** 3x3 for v1 (expandable to 10x10)
- **Built:** 3x3. Each room runs independently with own roach array, bot array. Transitions detected by edge crossing (`x < -5` or `x > 605`, etc).

### Motel Banking
- **Proposed:** Spawn every 15s, stay 10s, 5s to bank
- **Built:** Always active (0s spawn interval), stays 12s before relocating, 2s to bank. Much more accessible — banking is a constant strategic option, not a rare event. Banking progress degrades gradually when player leaves the boundary (instead of hard reset).

### Protocol
- **Proposed:** `input.move`, `state.delta`, etc.
- **Built:** Simpler flat types:

| Direction | Messages |
|-----------|----------|
| Client -> Server | `input` (position+velocity), `stomp` (x,y), `heal` |
| Server -> Client | `welcome` (full state), `tick` (room snapshot + events + personal state), `room_enter` (new room snapshot) |

**Key difference from proposal:** We send full room snapshots per tick, not deltas. At 20 TPS with ~20 entities per room, the JSON is small enough that delta compression isn't worth the complexity yet.

### Security Hardening (added post-initial build)
- **Rate limiting:** 60 messages/sec per player, silently dropped above threshold
- **Input validation:** Strict numeric sanitization, finite guards, clamping on all client values
- **Heal cooldown:** 200ms server-side to prevent spam
- **XSS prevention:** `escapeHtml()` on any player-sourced strings in log output
- **Path traversal protection:** Static file server validates paths

### What's NOT Built Yet

| Component | Status | Notes |
|-----------|--------|-------|
| Payments/Indexer | Not started | No crypto integration yet |
| Persistence Layer | **Done (M5)** | SQLite via better-sqlite3, session tokens, reconnection |
| Admin Console | Not started | No ops tooling |
| Wallet Connect | Not started | No auth at all — anonymous sessions |
| State Deltas | Skipped | Full snapshots instead (simpler, works fine) |
| Session Restore | **Done (M5)** | UUID session tokens in localStorage, 5-min restore window, banked balance persists forever |
| Room Sharding (multi-process) | Not started | Single process handles all rooms |

### Current File Map

```
kolkata/
├── server/
│   ├── index.js           # HTTP static server + WebSocket setup (80 lines)
│   ├── game-server.js     # Tick loop, sessions, room transitions, rate limiting (339 lines)
│   ├── room.js            # Per-room sim: physics, stomps, AoE, spawns (266 lines)
│   ├── roach.js           # Entity: movement, speed calc, hit/die (185 lines)
│   ├── house-bot.js       # Bot AI: targeting, pursuit, AoE stomp (156 lines)
│   ├── motel.js           # Banking: spawn/despawn, collision, progress (115 lines)
│   └── db.js              # SQLite persistence: players, sessions, bulk saves (105 lines)
├── client/
│   ├── index.html         # Full UI + CSS + mobile layout + prospector NPC (1007 lines)
│   ├── game.js            # Network, prediction, rendering, VFX, audio, touch controls (1516 lines)
│   └── assets/
│       ├── game-sprite.png
│       ├── roach-motel-sprite.jpeg
│       ├── prospector-closed.png
│       ├── prospector-speaking.png
│       ├── roachstomp_alive.wav
│       ├── roachstomp_dead.wav
│       ├── roach_player_dead.wav
│       ├── pickupCoin.wav
│       ├── bank.wav
│       ├── click.wav
│       └── synth.wav
├── shared/
│   └── constants.js       # All tuning values (42 lines)
├── package.json           # ws dependency, "start" script
└── AGENT-IMPLEMENTATION.md # Agent API plan (not built yet)
```

**Total: ~3,664 lines of game code.** Single dependency (`ws`).

### Current Game Constants (tuned through playtesting)

| Constant | Value | Why |
|----------|-------|-----|
| TICK_RATE | 50ms (20 TPS) | Balance of smoothness vs bandwidth |
| MAX_HP | 2 | Fast kills = more action |
| DEATH_PENALTY | 90% | High stakes |
| KILL_REWARD | 90% | Stomping is lucrative |
| INCOME_RATE | $0.01/sec | Slow passive accumulation |
| PLAYER_BASE_SPEED | 2.5 | Feels responsive with drunk steering |
| WEALTH_SPEED_PENALTY_MAX | 1.5 | Rich roaches noticeably slower |
| STOMP_AOE_RADIUS | 81px | Scaled up with sprite size increase |
| BOTS_PER_WEALTH | $5 | Aggressive bot scaling |
| MAX_BOTS_PER_ROOM | 8 | Can get very dangerous |
| BOT_STOMP_COOLDOWN | 600-900ms | Fast bot attacks |
| MOTEL_SAVE_TIME | 2s | Quick banking |
| MOTEL_STAY_DURATION | 12s | Always a motel somewhere |
| ROACH_SIZE | 47px | Scaled ~35% from original 35px |
| BOOT_SIZE | 135x149px | Scaled ~35% from original 100px |
| BOT_SIZE | 108x119px | Scaled ~35% from original 80px |

---

## Part 2: Milestone Roadmap (M1-M8)

### M1: Deploy & Share -- DONE
**Goal:** Shareable URL — anyone with the link plays instantly.

What was done:
- Server handles `process.env.PORT` for Railway/cloud deployment
- Package.json `start` script works out of the box (`node server/index.js`)
- WebSocket upgrades handled correctly
- Static file serving with path traversal protection
- Server fixes for Railway landed in PR #3

**Status:** Code is deploy-ready. Railway deployment is a manual step (connect repo, `railway up`).

---

### M2: Visual Polish -- DONE
**Goal:** Match the single-player prototype's visual richness in multiplayer.

What was built:
1. **Roach scaling with wealth** — all roaches (players + NPCs) scale via CSS transform based on balance (`1 + min(balance/25, 2)`, so 1x at $0 up to 3x at $50+). Applied in render loop for every entity.
2. **Roach rotation** — all roaches face movement direction via `Math.atan2(vy, vx)` -> CSS rotate
3. **Other players' boot cursors visible** — server broadcasts cursor positions, other clients render semi-transparent boots
4. **Sprite scaling** — all sprites scaled ~35% larger (roach 35->47px, boot 100->135px, bot 80->108px) with matching AoE radius bump (60->81px) — PR #5
5. **Combo kill VFX** — coin shower animations scale with consecutive kills — PR #2
6. **Stomp VFX** — screen shake, shockwave effects on impact — PR #2
7. **Prospector tutorial NPC** — 4-scene reactive tutorial with typewriter dialogue, deliberate beats/silence, no explicit instruction — player learns by doing. Scenes: game load, first kill, growth threshold, motel discovery. Auto-dismiss on scenes 2-4, close button only (no "go on"/"go away").
8. **Floating heal hint** — "SPACE TO HEAL" appears above injured player — PR #5
9. **Death splat animations, banking progress VFX** — visual feedback for all major actions

**Not ported from prototype (deprioritized):**
- NPC/player roaches flee from player boot cursors — gameplay impact, could be added later

---

### M3: Sound Design -- DONE
**Goal:** Audio feedback for all major actions.

What was built:
1. **AudioManager** — Web Audio API with buffer preloading and mobile unlock
2. **7 sound effects:**
   - `stomp_kill` — roachstomp_dead.wav (kill confirmed)
   - `stomp_hit` — roachstomp_alive.wav (damage dealt)
   - `player_dead` — roach_player_dead.wav (you died)
   - `coin` — pickupCoin.wav (income/loot)
   - `bank` — bank.wav (motel banking chime)
   - `click` — click.wav (UI interaction)
   - `synth` — synth.wav (ambient/event)
3. **Reversed coin buffer** — plays backwards for "losing money" feedback
4. **Staggered coin chimes** — `playCoins()` / `playReversedCoins()` for multi-coin events
5. **Mute toggle support**

---

### M4: Mobile Touch Controls -- DONE
**Goal:** Playable on phones.

What was built:
1. **Virtual joystick** — touch drag for movement, auto-shown on touch devices
2. **Tap to stomp** — touch anywhere in game area
3. **Responsive layout** — game container scales to viewport, separate mobile HUD
4. **Mobile-specific UI** — `#mobile-hud`, `#mobile-heal-bar`, `#mobile-minimap`, `#mobile-motel-info`
5. **Touch behavior prevention** — `touch-action: none` on game container
6. **Mobile detection** — `'ontouchstart' in window || navigator.maxTouchPoints > 0`
7. **Input validation hardened for mobile** — aligned sprite sizing with hitboxes, anchored VFX to visible mobile targets — PR #4

---

### M5: Persistence & Reconnection -- DONE
**Goal:** Banked balances survive server restarts. Players can reconnect after drops.

What was built:
1. **SQLite persistence** via `better-sqlite3` — `players` table (id, name, banked_balance, total_kills) + `sessions` table (room, position, balance, hp)
2. **Session tokens** — UUID v4 generated on first connect, stored in localStorage, sent on reconnect
3. **Reconnect with restore** — within 5 minutes: full position/room/balance/hp restore. After 5 minutes: fresh spawn but banked balance preserved forever
4. **Graceful shutdown** — SIGTERM/SIGINT handlers flush all sessions to DB before exit
5. **Periodic saves** — bulk session writes every ~10 seconds in tick loop
6. **Kill tracking** — lifetime kill stats persisted per player
7. **WAL mode** — for concurrent read/write performance

Files: new `server/db.js` (~105 lines), modified `server/game-server.js`, `server/index.js`, `client/game.js`

**Why this matters:** Foundation for long-term progression (M6 complete) and future M7/M8 systems.

---

### M6: Permanent Upgrades -- DONE
**Goal:** Give players something to spend $ROACH on that persists across deaths.
**Outcome:** Implemented full persistent upgrade economy with server-authoritative enforcement, modal shop UX, and mobile-friendly purchasing flow.

What was built:
1. **Persistent upgrade model** — added upgrade levels to SQLite player schema with backward-compatible migrations and save/load hooks.
2. **Upgrade catalog + scaling** — centralized defs/cost curves/helpers in shared constants (`bootSize`, `multiStomp`, `rateOfFire`, `goldMagnet`, `wallBounce`, `idleIncome`, `shellArmor`) with high max levels for incremental progression.
3. **Server-side purchase flow** — `buy_upgrade` message validation, max-level checks, affordability checks, and purchase success/failure responses.
4. **Bank-first spending** — purchases now withdraw from banked balance before wallet balance, with exact source amounts returned to client logs/UI.
5. **Server enforcement in gameplay** — stomp cooldown uses upgraded rate-of-fire, stomp zones honor boot-size + multi-stomp, wall bounce uses upgrade strength at room edges, and death penalty applies shell armor reduction.
6. **Economy effects from upgrades** — gold attraction multiplier and idle income are applied on server tick for player roaches.
7. **Shop modal UX** — dedicated popup store, grouped categories (`Fer yer Boot` / `Fer yer Roach`), prospector hover explanations, and stronger purchase feedback VFX/SFX.
8. **Mobile store fixes** — category tabs now switch views on small screens so sections don't collapse/smash together.
9. **Prospector onboarding polish** — tutorial now respects once-per-user onboarding flag and supports click-to-skip/click-to-close.

Files: `shared/constants.js`, `server/db.js`, `server/game-server.js`, `server/room.js`, `client/index.html`, `client/game.js`

---

### M7: Miniapp Integration -- NOT STARTED
**Goal:** $ROACH runs as a native miniapp inside Farcaster (Warpcast) and Base App, with platform identity mapped to persistent game sessions. World App support is a stretch goal.
**Effort:** 1–2 days
**Blocked by:** Nothing (M1-M6 complete, game is deployed on Railway)
**Priority:** Farcaster > Base App > World App (stretch)

What to build:

**Core (Farcaster + Base App):**
1. **Platform detection & adapter** (`client/platform.js`) — lightweight layer that detects which platform is hosting the app, loads the Farcaster SDK via CDN, and exposes a unified interface: `platform.type`, `platform.ready()`, `platform.getUser()`, `platform.getWalletProvider()`. Falls back gracefully to anonymous UUID sessions for standalone play.
2. **Manifest file** (`client/.well-known/farcaster.json`) — single manifest serves both Farcaster and Base App (they share the same format). Includes app name, icon, splash image, homeUrl, requiredChains.
3. **Server manifest route** — serve `.well-known/farcaster.json` from `server/index.js` with proper CORS headers.
4. **Platform identity mapping** — accept optional `platform`/`platformId` fields on WebSocket `reconnect` message. Add `platform_type` and `platform_id` columns to `players` table in `server/db.js`. Platform ID becomes an alternate lookup key for session restore.
5. **Account linking** — when a platform user connects and has an existing anonymous save slot (localStorage UUID), link the platform identity to that save slot. Once linked, the platform ID replaces the UUID as the session key, giving cross-device persistence for free.
6. **Viewport fixes** — `viewport-fit=cover`, `env(safe-area-inset-*)` CSS, OpenGraph meta tags for Base App compatibility.
7. **Asset creation** — `icon-1024.png` (1024×1024), `og-image.png` (1200×630), `splash.png` (200×200) in pixel art style.

**Stretch (World App):**
8. **World App SDK integration** — `@worldcoin/minikit-js` via jsdelivr CDN. `MiniKit.install()` on load. Identity-only (World ID verification skipped for now).
9. **World App Dev Portal setup** — manual registration (no code), documented below.

Platform SDK details:
- **Farcaster**: `@farcaster/miniapp-sdk` via esm.sh CDN. Must call `sdk.actions.ready()` after load. Auth via SIWF / quickAuth. Context provides FID, username, avatar.
- **Base App**: Uses same `.well-known/farcaster.json` manifest. Auto-detects Farcaster connector in miniapp context. Smart Wallet integration.
- **World App** (stretch): `@worldcoin/minikit-js` via jsdelivr CDN. `MiniKit.install()` on load. Identity-only for now.

World App Dev Portal setup (stretch):
1. Register at https://developer.worldcoin.org
2. Configure app URL (Railway domain), name, icon
3. Skip World ID verification for now — identity/session mapping only

Files: new `client/platform.js`, new `client/.well-known/farcaster.json`, new assets, modified `server/index.js`, `server/db.js`, `server/game-server.js`, `client/game.js`, `client/index.html`

---

### M8: Agent API (MoltBots-style) -- NOT STARTED
**Goal:** AI agents can connect and play alongside humans.
**Effort:** 3-5 days (re-estimated after latency/cost analysis)
**Blocked by:** Nothing (can be done anytime)

What to build (deep plan documented in `AGENT-IMPLEMENTATION.md`):
1. **Deterministic runtime first** (`agent/runtime/*`) — low-latency controller loop that runs every tick and executes movement/stomp/heal without waiting on LLM calls.
2. **Planner abstraction** (`agent/planner/*`) — contract-based strategy layer (`decide(observation) -> intent`) supporting both rule planners and LLM planners.
3. **Archetype set** — at least 3 rule archetypes + 2 LLM-guided archetypes (farmer, hunter, survival, disruptor, adaptive).
4. **LLM bridge + budget guardrails** — 500-1000ms planning cadence, strict tool schema, timeout fallback, and token/QPS caps.
5. **Agent identification** — `{ type: 'identify', agent: true }` message, UI tinting, and separate stats for human vs agent outcomes.
6. **Telemetry + benchmark harness** — bot-vs-bot match runner and metrics (banked/min, survival, K/D, motel conversion, API cost).

**Protocol is already compatible**, but production-quality LLM play requires latency-resilient control and cost governance beyond a thin SDK.

Files: new `agent/` directory, minor tweak to `server/game-server.js` (agent flag), optional telemetry endpoint(s)

---

### M9: Crypto Integration -- NOT STARTED
**Goal:** Real $ROACH token economy on Base chain.
**Effort:** Multiple days, separate workstream
**Blocked by:** Product/legal rollout decisions and chain-integration scope (core game prerequisites are now in place). M7 exposes wallet providers from each platform.

What to build:
1. **Vibecoins/Clanker token deployment** — $ROACH on Base
2. **Minting flow** — offchain mint triggered by Base $1 payment
3. **Withdrawal timelock** — request withdrawal, roach must survive N minutes while pending
4. **Payment indexer** — watch Base chain for mint/withdraw transactions, credit accounts
5. **Admin console** — view balances, process manual withdrawals, emergency controls
6. **Wallet connect** — browser wallet integration for Base (leverages M7 wallet provider abstraction)

Files: new `server/indexer.js`, new `server/admin.js`, `client/game.js` (wallet UI), `server/game-server.js` (withdrawal timer logic)

---

## Part 3: Current Status & Path to Shareable

### What's Done (M1-M6)
```
M1 (Deploy)      -- DONE  -- Server is deploy-ready, Railway-compatible
M2 (Visual)      -- DONE  -- Sprites scaled, VFX, prospector NPC, heal hints
M3 (Sound)       -- DONE  -- 7 SFX, AudioManager, mobile unlock, mute
M4 (Mobile)      -- DONE  -- Joystick, tap-stomp, responsive layout, mobile HUD
M5 (Persistence) -- DONE  -- SQLite, session tokens, reconnection, graceful shutdown
M6 (Upgrades)    -- DONE  -- Persistent progression + bank-first shop + modal store UX
```

**The game is fully playable and shareable right now.** Desktop + mobile, sound, tutorial NPC, persistent progression, and upgrade economy are all live. The only manual step is connecting the repo to Railway (or any Node host).

### What's NOT Done (M7-M9)
```
M7 (Miniapps)     -- NOT STARTED  -- Farcaster/Base (primary), World (stretch)
M8 (Agents)       -- NOT STARTED  -- Protocol is ready, needs SDK/docs
M9 (Crypto)       -- NOT STARTED  -- Can proceed now that M6 is complete
```

### Bonus Work Completed (not in original milestones)
- **Prospector tutorial rewrite + onboarding persistence** — replaced instructional onboarding with 4-scene reactive system and added once-per-user local onboarding flag plus skip/close controls.
- **Store narrative UX** — prospector integrated into shop with contextual explanations and animated speaking.
- **Security hardening** — rate limiting, input validation, XSS prevention, path traversal protection
- **Balance math fix** — death penalty correctly applied before `die()`
- **Motel banking improvement** — gradual progress degradation instead of hard reset
- **Heal cooldown** — 200ms server-side to prevent spam

### To Make It "Shareable" (minimum viable share)

**Already done — just deploy:**
1. Connect GitHub repo to Railway (or `railway up`)
2. Verify multiplayer works on phone + laptop simultaneously
3. Share the URL

**Nice-to-haves before sharing (quick wins, ~1-2 hours each):**
- **Player count indicator** — show "X players online" (data exists, just needs UI)
- **Kill feed** — "[Player] stomped [Player]" visible to room (adds social pressure)
- **Leaderboard** — in-memory top-10 by banked balance on connection screen (no persistence needed)

### What to Skip or Defer
- **10x10 grid** — 3x3 is fine until you have 50+ concurrent players
- **State deltas** — full snapshots work fine at current scale
- **TypeScript migration** — not worth it at ~3,600 lines
- **Multi-process sharding** — single process handles hundreds of players

### What to Watch For
- **Movement feel on real networks** — the client-authoritative model feels great on localhost but needs testing with 50-100ms latency. May need to tune the 50px reconciliation threshold.
- **Bot difficulty scaling** — with 8 max bots and 2 HP, rooms can become kill zones. May need to cap AoE or add bot flee behavior.
- **Motel balance** — 2s banking is very fast. If money accumulates too easily, the death penalty loses its sting. Monitor average banked balances.
