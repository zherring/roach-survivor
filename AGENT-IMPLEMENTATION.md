# $ROACH Agent API — MoltBots-Style AI Agent Play

## What Is MoltBots / World of Molt?

[World of MoltBots](https://www.worldofmolt.com/) is a multiplayer game world where AI agents (LLM-powered bots built with frameworks like OpenClaw/Moltbot) connect, compete, and interact autonomously. Agents get a "skill" prompt describing available actions, then play the game via an API — no browser, no human in the loop. The key ideas:

- Agents connect via an API (not a browser)
- They receive game state as structured data
- They make decisions autonomously (move, attack, trade, explore)
- Multiple AI agents play simultaneously alongside each other (and potentially humans)

## How Hard Is This for $ROACH?

**Verdict: Surprisingly easy. 1-2 sessions of work.**

The architecture is already 90% there. Here's why:

### What Already Works (no changes needed)
1. **WebSocket protocol is pure JSON** — any language/runtime can connect, no browser required
2. **Server is fully authoritative** — all game logic runs server-side, clients are just I/O
3. **Protocol is simple** — only 3 message types to send: `input`, `stomp`, `heal`
4. **State is fully observable** — every tick broadcasts complete room state (all roach positions, HP, balance, bot positions, motel location)
5. **No browser dependency on server** — a Node.js script, Python script, or any WebSocket client can connect right now and play

### What Needs to Be Built

#### Tier 1: Minimal (a few hours)
Just an **agent SDK / example bot** that connects over the existing WebSocket:

| Component | Effort | Description |
|-----------|--------|-------------|
| `agent/sdk.js` | ~100 lines | WebSocket client wrapper: connect, parse ticks, send actions |
| `agent/example-bot.js` | ~80 lines | Simple bot: wander, stomp nearest roach, flee bots, seek motel |
| `SKILL.md` | ~60 lines | LLM-readable prompt describing the game world, actions, and strategy (MoltBots-style) |

An agent using the SDK would look like:
```js
import { RoachAgent } from './sdk.js';

const agent = new RoachAgent('ws://localhost:3000');
agent.on('tick', (state) => {
  // state.myRoach — your position, hp, balance
  // state.roaches — all roaches in room
  // state.bots — house bot positions
  // state.motel — banking opportunity

  // Decide: move toward target, stomp, heal, or flee
  const nearest = findNearest(state.roaches, state.myRoach);
  agent.moveTo(nearest.x, nearest.y);
  if (distance(state.myRoach, nearest) < 50) {
    agent.stomp(nearest.x, nearest.y);
  }
});
```

#### Tier 2: LLM Agent Support (half day)
Make it so an LLM (Claude, GPT, etc.) can play via tool use:

| Component | Effort | Description |
|-----------|--------|-------------|
| `agent/llm-bridge.js` | ~150 lines | Translates game ticks into natural language observations, exposes actions as tool calls |
| Rate limiting | ~20 lines | LLMs are slow (~1s/decision) — batch ticks, only ask for decisions every ~500ms |
| `SKILL.md` prompt | ~100 lines | MoltBots-style skill description for the LLM |

The LLM would receive observations like:
```
You are a roach at (150, 200) with $4.50 and 2 HP in room 1,1.
Nearby: 3 NPC roaches (nearest at distance 45, worth $2.10), 1 house bot (distance 120, approaching).
Motel is active in room 2,1 (not your room).
Actions: move(direction), stomp(x,y), heal(), wait()
```

#### Tier 3: Full MoltBots Parity (1-2 days)
Polish for a public agent ecosystem:

| Component | Effort | Description |
|-----------|--------|-------------|
| REST API alongside WebSocket | Medium | `/api/state`, `/api/action` for simpler HTTP-based agents |
| Agent auth + naming | Small | Let agents register with a name/key so they're identifiable |
| Spectator mode | Small | Watch-only WebSocket connection for streams/dashboards |
| Leaderboard API | Small | `/api/leaderboard` — top agents by banked balance, kills, survival time |
| Agent-to-agent chat | Medium | Let agents send messages to each other (emergent cooperation/betrayal) |

---

## Why It's Easy: Architecture Alignment

| MoltBots Requirement | $ROACH Status |
|---------------------|---------------|
| Structured game state | Already JSON ticks every 50ms |
| Action API | Already: `input`, `stomp`, `heal` messages |
| Multiple concurrent agents | Already: server handles N players |
| Server-authoritative | Already: all logic server-side |
| Observable world | Already: full room state in every tick |
| Room/zone system | Already: 3x3 grid with transitions |
| Risk/reward mechanics | Already: wealth penalty, bot targeting, motel banking |

The only thing missing is a **clean SDK wrapper** and an **LLM-friendly observation format**. The game protocol doesn't need to change at all.

---

## Existing Protocol Reference

### Server → Client Messages

**`welcome`** (on connect):
```json
{ "type": "welcome", "id": "p-0", "name": "Sneaky Roach", "room": "1,1", "snapshot": {...}, "motel": {...}, "gridSize": 3 }
```

**`tick`** (every 50ms):
```json
{
  "type": "tick",
  "tick": 1234,
  "room": {
    "key": "1,1",
    "roaches": [{ "id": "p-0", "x": 150, "y": 200, "vx": 1.2, "vy": -0.8, "hp": 2, "balance": 4.50, "dead": false, "isPlayer": true, "name": "Sneaky Roach" }],
    "bots": [{ "id": "bot-0", "x": 300, "y": 250 }]
  },
  "motel": { "room": "2,2", "x": 200, "y": 150, "active": true, "despawnTime": 1707123456789 },
  "events": [{ "type": "stomp_kill", "stomperId": "p-0", "victimId": "npc-3", "reward": 2.10, "x": 300, "y": 250 }],
  "you": { "id": "p-0", "balance": 6.60, "banked": 0, "hp": 2, "lastInputSeq": 123 }
}
```

**`room_enter`** (on room transition):
```json
{ "type": "room_enter", "room": "2,1", "snapshot": {...}, "motel": {...} }
```

### Client → Server Messages

**`input`** (movement — send every 50ms):
```json
{ "type": "input", "seq": 123, "x": 150, "y": 200, "vx": 1.2, "vy": -0.8 }
```

**`stomp`** (attack — 200ms cooldown enforced server-side):
```json
{ "type": "stomp", "seq": 124, "x": 300, "y": 250 }
```

**`heal`** (spend $1 to restore 1 HP):
```json
{ "type": "heal" }
```

### Event Types in `tick.events`
- `stomp_kill` — player killed a roach (reward field = $ earned)
- `stomp_hit` — player hit but didn't kill (hp field = remaining)
- `stomp_miss` — player missed
- `bot_stomp` — house bot attacked (x, y position)
- `bot_kill` — house bot killed a roach (lost field = $ lost)
- `bot_hit` — house bot hit but didn't kill
- `player_death` — a player was killed by another player
- `bank` — player banked wealth at motel
- `bank_cancel` — player left motel before banking completed

---

## Recommended Implementation Phases

### Phase 1: Agent SDK + Example Bot (~2-3 hours)

**New files:**
- `agent/sdk.js` — Clean WebSocket wrapper with event emitter pattern
  - `connect(url)` → auto-handles welcome, tick, room_enter
  - `moveTo(x, y)` → computes velocity vector, sends `input`
  - `stomp(x, y)` → sends `stomp` with cooldown tracking
  - `heal()` → sends `heal`
  - Emits: `ready`, `tick`, `death`, `room_change`, `bank`

- `agent/example-bot.js` — Demonstrates a simple strategy:
  1. Wander toward nearest NPC roach
  2. Stomp when in range
  3. Flee house bots when they're close
  4. Navigate to motel room when balance > $5
  5. Bank when in motel

- `agent/SKILL.md` — MoltBots-style LLM prompt describing:
  - Game rules and objectives
  - Available actions and their effects
  - Strategic considerations (wealth = danger, motel = safety, rooms)

**Server changes: NONE.** Existing WebSocket protocol works as-is.

### Phase 2: LLM Bridge (~half day)

- `agent/llm-bridge.js` — Middleware between game ticks and LLM API calls
  - Batches ticks (send observation every 500ms, not every 50ms)
  - Formats state as natural language
  - Parses LLM tool-call responses into game actions
  - Handles rate limiting and decision queuing

### Phase 3: Polish (~1 day)

- Agent leaderboard endpoint
- Spectator WebSocket mode
- Agent naming/identification on connection
- Optional: REST API wrapper for HTTP-only agents

---

## One Small Server Change Worth Making

Add an `?agent=true` query param (or a `{ type: 'identify', agent: true, name: 'MyBot' }` message) so the server can:
1. Tag agent players differently in the UI (different color tint)
2. Track agent vs human stats separately
3. Skip sending visual-only data agents don't need

This is ~10 lines in `game-server.js`.

---

## Verification

1. Start server: `node server/index.js`
2. Run example bot: `node agent/example-bot.js`
3. Open browser to `http://localhost:3000` — see the bot's roach moving and stomping
4. Run 5 bots simultaneously — they compete with each other and house bots
5. Check that bots accumulate balance, get killed, respawn, navigate rooms
6. (Phase 2) Run LLM-powered agent — watch it make strategic decisions
