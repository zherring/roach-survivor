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
  - AoE gradient damage (probability falloff from stomp center, 60px radius)
  - HP reduced to 2 (was 3 in PRD)
  - House bots have wealth-weighted targeting (`weight = balance + 0.1`)
  - Bot pursuit speed scales with target wealth (`3 + min(balance * 0.15, 2)`)
  - Combo kill VFX system (coin shower scales with consecutive kills within 1.5s)

### Room Grid
- **Proposed:** 3x3 for v1 (expandable to 10x10)
- **Built:** 3x3. Each room runs independently with own roach array, bot array. Transitions detected by edge crossing (`x < -5` or `x > 605`, etc).

### Motel Banking
- **Proposed:** Spawn every 15s, stay 10s, 5s to bank
- **Built:** Always active (0s spawn interval), stays 12s before relocating, 2s to bank. Much more accessible — banking is a constant strategic option, not a rare event.

### Protocol
- **Proposed:** `input.move`, `state.delta`, etc.
- **Built:** Simpler flat types:

| Direction | Messages |
|-----------|----------|
| Client → Server | `input` (position+velocity), `stomp` (x,y), `heal` |
| Server → Client | `welcome` (full state), `tick` (room snapshot + events + personal state), `room_enter` (new room snapshot) |

**Key difference from proposal:** We send full room snapshots per tick, not deltas. At 20 TPS with ~20 entities per room, the JSON is small enough that delta compression isn't worth the complexity yet.

### What's NOT Built Yet

| Component | Status | Notes |
|-----------|--------|-------|
| Payments/Indexer | Not started | No crypto integration yet |
| Persistence Layer | Not started | All state in-memory, lost on restart |
| Admin Console | Not started | No ops tooling |
| Wallet Connect | Not started | No auth at all — anonymous sessions |
| State Deltas | Skipped | Full snapshots instead (simpler, works fine) |
| Reconnect Handling | Not started | Disconnect = player removed |
| Room Sharding (multi-process) | Not started | Single process handles all rooms |

### Current File Map

```
kyiv/
├── server/
│   ├── index.js           # HTTP static server + WebSocket setup (77 lines)
│   ├── game-server.js     # Tick loop, sessions, room transitions (229 lines)
│   ├── room.js            # Per-room sim: physics, stomps, AoE, spawns (263 lines)
│   ├── roach.js           # Entity: movement, speed calc, hit/die (157 lines)
│   ├── house-bot.js       # Bot AI: targeting, pursuit, AoE stomp (156 lines)
│   └── motel.js           # Banking: spawn/despawn, collision, progress (109 lines)
├── client/
│   ├── index.html         # Full UI + CSS (471 lines)
│   ├── game.js            # Network, prediction, rendering, VFX (793 lines)
│   └── assets/
│       ├── game-sprite.png
│       └── roach-motel-sprite.jpeg
├── shared/
│   └── constants.js       # All tuning values (41 lines)
├── package.json           # ws dependency, "start" script
└── AGENT-IMPLEMENTATION.md # Agent API plan (not built yet)
```

**Total: ~2,200 lines of game code.** Single dependency (`ws`).

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
| STOMP_AOE_RADIUS | 60px | Meaningful splash zone |
| BOTS_PER_WEALTH | $5 | Aggressive bot scaling |
| MAX_BOTS_PER_ROOM | 8 | Can get very dangerous |
| BOT_STOMP_COOLDOWN | 600-900ms | Fast bot attacks |
| MOTEL_SAVE_TIME | 2s | Quick banking |
| MOTEL_STAY_DURATION | 12s | Always a motel somewhere |

---

## Part 2: Milestone Roadmap (M1-M8)

### M1: Deploy & Share
**Goal:** Shareable URL — anyone with the link plays instantly.
**Effort:** 30 minutes
**Blocked by:** Nothing

What to do:
- Deploy to Railway (`railway up` or connect GitHub repo)
- Railway auto-detects Node via `package.json`, uses `npm start` → `node server/index.js`
- PORT comes from `process.env.PORT` (already handled)
- WebSocket upgrades work on Railway out of the box
- Verify: open on phone + laptop simultaneously, confirm multiplayer works

**Why first:** Everything else is pointless if nobody can play it. This is the lowest-effort, highest-leverage step.

---

### M2: Visual Polish — Prototype Feature Parity
**Goal:** Match the single-player prototype's visual richness in multiplayer.
**Effort:** Half day
**Blocked by:** Nothing

What to build:
1. **Roach scaling with wealth** — CSS `transform: scale()` based on balance (1x at $0, up to 3x at $50+). Already in the prototype, just needs porting to the multiplayer renderer.
2. **Roach rotation** — face movement direction via `Math.atan2(vy, vx)` → CSS rotate. Already in prototype.
3. **Other players' boot cursors visible** — server broadcasts each player's cursor position, other clients render a semi-transparent boot. Needs new message field in `input` (cursor x,y) and render logic.
4. **NPC/player roaches flee from player boots** — currently they only flee house bots. Add player cursor positions to the flee calculation in `server/roach.js`.

Files: `client/game.js` (render scaling/rotation/other boots), `server/game-server.js` (broadcast cursor positions), `server/roach.js` (flee from player cursors)

**Why second:** These are the most visible "this feels like a real game" improvements. Roaches that grow fat and slow as they get rich is a core part of the game's visual storytelling.

---

### M3: Sound Design
**Goal:** Audio feedback for all major actions — stomp, kill, coin, bot, motel.
**Effort:** Half day
**Blocked by:** Nothing (can parallelize with M2)

What to build:
1. Web Audio API sound system (small AudioContext manager)
2. Sound effects: stomp impact (hit vs miss), death squelch, coin collect, bot stomp rumble, motel banking chime, ambient skittering
3. Volume controls / mute button
4. Generate or source 6-8 short sound clips (can use free SFX libraries or AI generation)

Files: `client/game.js` (audio hookup), `client/assets/` (sound files), `client/index.html` (mute button)

**Why third:** Sound is what makes the difference between "prototype" and "game". Stomping without a satisfying crunch feels hollow. This is high-impact for minimal code.

---

### M4: Mobile Touch Controls
**Goal:** Playable on phones — huge for viral sharing.
**Effort:** 1 day
**Blocked by:** M1 (need deployment to test on real phones)

What to build:
1. **Virtual joystick** — touch drag in bottom-left for movement (maps to WASD forces)
2. **Tap to stomp** — touch anywhere in game area to stomp at that position
3. **Responsive layout** — game container scales to viewport width, stats bar wraps
4. **Touch-friendly heal button** — larger hit target
5. **Prevent default touch behaviors** — no scroll/zoom on game container

Files: `client/game.js` (touch input handlers, joystick logic), `client/index.html` (responsive CSS, joystick element)

**Why fourth:** Mobile is where viral sharing happens — someone sends a link in a group chat, everyone opens it on their phone. Without touch controls, that entire funnel is broken.

---

### M5: Persistence & Reconnection
**Goal:** Banked balances survive server restarts. Players can reconnect after drops.
**Effort:** 1 day
**Blocked by:** M1 (need to know deploy environment for storage)

What to build:
1. **SQLite (or JSON file) persistence** for banked balances, player names, upgrade state
2. **Session tokens** — localStorage on client, cookie or generated ID, maps to persistent player record
3. **Reconnect logic** — client auto-reconnects on WebSocket close, sends session token, server restores player to their room with banked balance intact
4. **Graceful shutdown** — server writes state to disk on SIGTERM (Railway sends this before restart)

Files: new `server/db.js`, `server/game-server.js` (session restore, shutdown hook), `client/game.js` (reconnect loop, session storage)

**Why fifth:** Once real players are playing (M1) and having fun (M2-M4), losing progress on server restart becomes the #1 frustration. This is the foundation for everything that follows (upgrades, leaderboards, crypto).

---

### M6: Permanent Upgrades
**Goal:** Give players something to spend $ROACH on that persists across deaths.
**Effort:** 1-2 days
**Blocked by:** M5 (needs persistence)

What to build:
1. **Boot Size upgrade** — wider stomp hitbox (multiply BOOT_WIDTH/BOOT_HEIGHT by upgrade level)
2. **Multi-stomp** — additional hit zones around main stomp point
3. **Rate-of-fire** — lower STOMP_COOLDOWN per upgrade level
4. **Upgrade shop UI** — panel showing available upgrades, costs, current levels
5. **Server enforcement** — apply upgrade modifiers in `room.resolveStomp()`, validate on stomp cooldown
6. **Visual indicators** — bigger boot for boot-size upgrade, multiple impact marks for multi-stomp

Files: `server/game-server.js` (purchase handler), `server/room.js` (apply modifiers), `server/db.js` (persist upgrades), `client/game.js` (shop UI, visual changes)

**Why sixth:** Upgrades create the spending imperative — the core economic tension. Right now there's nothing to do with money except bank it. Upgrades make the economy loop work: earn → spend on upgrades (safe) vs hoard (risky).

---

### M7: Agent API (MoltBots-style)
**Goal:** AI agents can connect and play alongside humans.
**Effort:** Half day
**Blocked by:** Nothing (can be done anytime)

What to build (documented in `AGENT-IMPLEMENTATION.md`):
1. **Agent SDK** (`agent/sdk.js`) — WebSocket wrapper with `moveTo()`, `stomp()`, `heal()` methods
2. **Example bot** (`agent/example-bot.js`) — hunts NPCs, flees bots, banks at motel
3. **SKILL.md** — LLM-readable game description for MoltBots/OpenClaw integration
4. **Agent identification** — `{ type: 'identify', agent: true }` message, different color tint in UI

**No server changes needed** for basic agent support — the WebSocket protocol works as-is for any client.

Files: new `agent/` directory, minor tweak to `server/game-server.js` (agent flag)

**Why seventh:** The protocol is already agent-friendly. This is mostly a packaging/documentation exercise. Cool demo potential but doesn't affect core gameplay.

---

### M8: Crypto Integration
**Goal:** Real $ROACH token economy on Base chain.
**Effort:** Multiple days, separate workstream
**Blocked by:** M5 (persistence), M6 (upgrades — need something to spend on)

What to build:
1. **Vibecoins/Clanker token deployment** — $ROACH on Base
2. **Minting flow** — offchain mint triggered by Base $1 payment
3. **Withdrawal timelock** — request withdrawal, roach must survive N minutes while pending
4. **Payment indexer** — watch Base chain for mint/withdraw transactions, credit accounts
5. **Admin console** — view balances, process manual withdrawals, emergency controls
6. **Wallet connect** — browser wallet integration for Base

Files: new `server/indexer.js`, new `server/admin.js`, `client/game.js` (wallet UI), `server/game-server.js` (withdrawal timer logic)

**Why last:** This is the biggest lift, needs the most infrastructure, and only matters once you have real players engaged. The game needs to be fun and sticky first. Crypto is the monetization layer, not the fun layer.

---

## Part 3: Recommendations

### Priority Order
```
M1 (Deploy) → M2 (Visual) → M3 (Sound) → M4 (Mobile)
    ↓
"Shareable, impressive, playable everywhere"
    ↓
M5 (Persistence) → M6 (Upgrades) → M7 (Agents) → M8 (Crypto)
    ↓
"Sticky, economic, expandable"
```

### What to Skip or Defer
- **10x10 grid** — 3x3 is fine until you have 50+ concurrent players. More rooms = more empty rooms.
- **State deltas** — full snapshots work. Only optimize if bandwidth becomes an issue.
- **TypeScript migration** — not worth the friction for the current codebase size (~2200 lines). Revisit if it grows past 5k.
- **Multi-process sharding** — single process handles hundreds of players. Only shard if you hit CPU limits.

### What to Watch For
- **Movement feel on real networks** — the client-authoritative model feels great on localhost but needs testing with 50-100ms latency. May need to tune the 50px reconciliation threshold.
- **Bot difficulty scaling** — with 8 max bots and 2 HP, rooms can become kill zones. May need to cap AoE or add bot flee behavior.
- **Motel balance** — 2s banking is very fast. If money accumulates too easily, the death penalty loses its sting. Monitor average banked balances.

### Quick Wins Not in the Milestones
- **Player count indicator** — show "X players online" (already have the data, just need UI)
- **Kill feed** — show "[Player] killed [Player]" visible to all players in room
- **Leaderboard** — simple in-memory top-10 by banked balance, displayed on connection screen
- **Spectator mode** — WebSocket connection that receives ticks but can't send input (trivial)
