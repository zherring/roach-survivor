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

---

## Deep Implementation Plan (M8) — Constraints, Strategy, and Best Path Forward

This section expands the milestone into an implementation-ready plan that accounts for real-world LLM constraints (especially latency and token cost) and supports both deterministic bots and LLM-directed bots.

### 1) Constraint Research Summary (What MoltBot-style systems run into)

Across API-driven game agents, the practical constraints are usually:

1. **Decision latency dominates**
   - Local game ticks are fast (here: every 50ms), but LLM round-trips are slow (typically ~400ms to 3000ms depending on model + load).
   - If you call an LLM per tick, the bot is effectively frozen while the world moves.

2. **Token bandwidth is finite**
   - Full state every 50ms is too expensive to repeatedly serialize to LLMs.
   - Agents need compressed observations (local neighborhood + important deltas + recent events).

3. **Action cadence mismatch**
   - Game expects high-frequency movement updates.
   - LLMs produce low-frequency strategic intents.
   - You need an intermediate controller to convert intent -> continuous control.

4. **Non-deterministic output and formatting errors**
   - Free-form LLM responses can violate schemas or issue impossible actions.
   - Strict tool calling and server-side validation are mandatory.

5. **Burst concurrency costs**
   - Running many LLM bots simultaneously can explode cost and API QPS.
   - Need model tiering, budgets, and graceful fallback to rule policies.

6. **Partial observability-by-budget (not by protocol)**
   - Protocol provides full room state, but for LLM scale you must intentionally redact/summarize.

### 2) Architectural Implication: Two-Layer Bot Brain

To handle latency while staying competitive, each bot should have:

- **Layer A: Real-time Controller (deterministic, 20 TPS)**
  - Maintains local world model.
  - Executes movement, spacing, stomp windows, flee vectors.
  - Always active even when LLM is unavailable.

- **Layer B: Strategic Planner (LLM or rule planner, 1-2 Hz)**
  - Chooses high-level mode: `farm`, `hunt_player`, `bank_run`, `evade`, `heal_reset`, `room_rotate`.
  - Emits policy parameters (risk tolerance, target priority, disengage threshold).

This decoupling is the key to making LLM bots viable.

### 3) Recommended Bot Portfolio ("five LLMs + archetypes")

Target a mixed ecology instead of all bots using the same expensive model:

1. **Scout/Farmer Archetype**
   - Objective: stable income, low risk, frequent banking.
   - Model: small/fast model (or pure rules).

2. **Opportunist Hunter Archetype**
   - Objective: punish weak/high-balance targets.
   - Model: medium model with tactical reasoning.

3. **Tank/Survival Archetype**
   - Objective: minimize deaths, heal early, avoid bot clusters.
   - Model: small/medium.

4. **Disruptor Archetype**
   - Objective: deny banks, contest motel timing, room pressure.
   - Model: medium/high.

5. **Meta-Adaptive Captain Archetype**
   - Objective: dynamic strategy switching based on lobby state.
   - Model: highest-quality model, lowest bot count.

Important: these can map to five model tiers OR a single model with five system prompts. Start with prompt variants first; add multi-model routing once metrics are live.

### 4) Hard Parts and Design Considerations

1. **Latency-safe control**
   - Requirement: bot remains active with no LLM response for several seconds.
   - Solution: "last good plan" + deterministic fallback FSM + timeout downgrade.

2. **Observation compression**
   - Build per-bot feature vector + short textual summary:
     - nearest 3 threats, nearest 5 prey, motel status, own hp/balance/banked, recent damage/kills.
   - Include deltas since last planner call, not full snapshots.

3. **Intent compiler**
   - Convert planner outputs into executable control fields:
     - `mode`, `targetId/targetPos`, `riskBudget`, `stompAggression`, `bankThreshold`, `retreatHp`.

4. **Action legality and anti-cheat parity**
   - Bot actions must go through same server constraints as humans.
   - No privileged endpoints for LLM bots.

5. **Evaluation harness**
   - Need reproducible bot-vs-bot tournaments to compare strategies.
   - Metrics: banked/minute, survival time, K/D, motel conversion %, API cost per 10 minutes.

6. **Cost governance**
   - Per-bot and per-match token budgets.
   - Soft cap -> reduce planner frequency.
   - Hard cap -> degrade to deterministic policy.

7. **Failure handling**
   - LLM timeout, malformed tool output, provider outage, rate-limit spikes.
   - Must never crash match loop.

### 5) Optimal Implementation Path (recommended)

#### Phase A — Deterministic Bot Runtime First (foundation, 1-2 days)
- Build `agent/runtime/` with:
  - world-state cache
  - utility scoring (farm/hunt/bank/evade)
  - continuous movement + stomp windowing
- Ship 3 non-LLM archetypes to validate game balance and API shape.

#### Phase B — Planner Interface + Offline Replay (1 day)
- Define planner contract (`decide(observation) -> intent`).
- Add replay runner that feeds recorded ticks and scores outcomes.
- Validate archetypes offline before live deployment.

#### Phase C — LLM Bridge with Strict Tool Schema (1 day)
- Add `agent/llm-bridge.js`:
  - planner loop every 500-1000ms
  - JSON schema/tool call only
  - retry-once then fallback
- Start with 1-2 LLM bots max in live rooms.

#### Phase D — Multi-Archetype League + Budgets (1 day)
- Run 5 archetypes concurrently (mixed LLM/rules).
- Add budget manager and adaptive cadence.
- Collect telemetry dashboard for cost/performance.

#### Phase E — Milestone Closeout (0.5 day)
- Publish `agent/SKILL.md`, examples, and benchmark report.
- Add server-side agent tagging + leaderboard split (human vs agent).

### 6) Planner Cadence Recommendations (LLM latency aware)

- **Default:** planner at 2 Hz (every 500ms).
- **Under load:** drop to 1 Hz (1000ms).
- **Critical moments only:** trigger immediate re-plan when:
  - hp changed,
  - entered/leaving motel radius,
  - new high-value threat within danger radius,
  - room transition.

This event-driven bump avoids constant high-frequency LLM calls while preserving responsiveness.

### 7) Minimal Data Contract for LLM Planner

Use compact structured JSON (not raw full tick):

- `self`: hp, balance, banked, pos, velocity, cooldowns
- `threats[]`: id, dist, bearing, dangerScore
- `prey[]`: id, dist, expectedReward, hp
- `motel`: active, roomDelta, eta, contestLevel
- `recentEvents`: damageTaken, kills, bankInterrupts
- `policyMemory`: lastMode, lastTarget, stuckCounter

Return only:
- `mode`
- `target`
- `risk`
- optional `notes`

Controller handles actual `input/stomp/heal` emission.

### 8) Milestone Acceptance Criteria (updated)

M8 should be considered complete when:

1. At least **3 deterministic archetype bots** can run 24/7 without LLM.
2. At least **2 LLM-guided archetypes** run with timeout fallback and no loop instability.
3. A **5-archetype mixed match** runs for 30+ minutes with telemetry.
4. Budget controls cap LLM spend and auto-downgrade correctly.
5. Documentation includes SKILL + strategy profiles + benchmarking process.

### 9) Best Path Forward (final recommendation)

**Do not start with five always-on LLM bots.**
Start with deterministic controllers and a planner abstraction, then layer in LLMs as sparse strategic supervisors.

This gives:
- Low-latency play quality,
- Controlled API cost,
- Easier debugging,
- Better competitive behavior under real production constraints.

In short: **rules for reflexes, LLMs for strategy** is the optimal architecture for MoltBots-style play in $ROACH.
