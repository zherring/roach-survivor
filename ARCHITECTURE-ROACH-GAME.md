# $ROACH Multiplayer Architecture (Draft)

This document proposes a production architecture for the $ROACH game described in `PRD-ROACH-GAME.md`. It focuses on a shared, authoritative game engine with real-time state across all browsers, plus onchain payments for minting and in-game purchases. It is intentionally pragmatic: small-team friendly, deployable quickly, and scalable as traction grows.

## Goals
- Shared, authoritative game state across all connected players.
- Real-time multiplayer with low latency for stomps and movement.
- Crypto payments for minting roaches and spending $ROACH.
- Mobile-friendly web client that can be embedded/shared (e.g., FC).
- Operable by a small team; minimal infrastructure overhead.

## Non-Goals (for v1)
- Fully trustless gameplay or onchain game state.
- Automated withdrawals (manual EOW is acceptable).
- Complex NFT trait pipelines or large-scale onchain metadata.

## Assumptions
- "FC" refers to Farcaster distribution.
- "Base" refers to the Base app (including its mini-app surface).
- $ROACH will likely be a Clanker coin; 90% reserved for the game and distributed weekly.
- Minting is offchain initially; NFT airdrop may happen later.
- Onchain payments are limited to $1 withdrawals from user wallets (Base).
- $ROACH is represented as an internal game balance; onchain settlement is not part of v1 gameplay.

## High-Level Architecture
- **Client (Web)**: Canvas-based game client, input capture, local prediction, UI, wallet connect.
- **Game Server (Authoritative)**: Single source of truth for rooms, roaches, stomps, bots, economy.
- **Realtime Transport**: WebSocket-based state deltas and input events.
- **Payments/Indexer**: Watches onchain events and credits player accounts.
- **Persistence**: Minimal state persistence (accounts, balances, upgrades, banked $ROACH).
- **Admin Console**: Manual withdrawal workflow and ops controls.
- **Room Grid (v1)**: 3x3 rooms (expandable later).

## Key Principles
- **Server-authoritative simulation**: Clients send inputs, server resolves stomps and state changes.
- **Deterministic ticks**: Fixed simulation tick (e.g., 20–30 TPS) for consistency.
- **State deltas**: Broadcast small diffs vs. full state each frame.
- **Room sharding**: Each room is independent for scale; shard by room key.

## Core Components

### 1) Web Client
Responsibilities:
- Input capture (WASD/joystick, tap/click)
- Local prediction for movement and boot visuals
- Receives state deltas (positions, HP, balances, bots)
- Renders sprites, minimap, motel timers, indicators
- Wallet connection for payments (Base)
 - Surfaces "play without minting" and "mint to own" UX

Notes:
- Client should not be trusted for hits, damage, balances, or room transitions.
- Prediction should be corrected with server reconciliation.

### 2) Game Server (Authoritative Engine)
Responsibilities:
- Tick loop for each room shard
- Resolve stomps, hits, deaths, respawns, motel banking
- Apply rubber-band speed and wealth scaling
- Spawn/despawn house bots based on room wealth
- Enforce rate-of-fire, miss penalties, and hitboxes
- Maintain player sessions and room membership
 - Track unowned vs owned balances until a roach is minted

Suggested structure:
- **RoomManager**: Creates, destroys, and ticks rooms.
- **Room**: Holds roaches, bots, motel state, per-room economy.
- **Simulation**: Deterministic step with a fixed delta (e.g., 50ms).
- **EventBus**: Internal events (death, stomp, banked, mint).

### 3) Realtime Transport
Responsibilities:
- Low-latency bi-directional data (WebSockets)
- Input events from clients (move, stomp, heal, bank)
- State delta updates to clients (positions, hp, balances)
- Presence tracking and reconnect handling

Message types (examples):
- `input.move`, `input.stomp`, `input.heal`, `input.bank`
- `state.delta`, `state.snapshot`, `event.death`, `event.motel`

### 4) Payments + Indexing
Responsibilities:
- Watch onchain $1 withdrawal events (Base)
- Credit player account balances/upgrades after mint
- Prevent duplicate credits (idempotent)
- Optionally allow anonymous minting tied to session

Flow:
1) Player initiates mint (offchain) or withdrawal (onchain).
2) Onchain transaction confirmed (Base $1 withdraw).
3) Indexer sees event and credits the player.
4) Game server syncs account balance and unlocks roach ownership.

### 4b) Treasury + Weekly Distribution (Clanker)
Responsibilities:
- Track the game-reserved 90% allocation of $ROACH.
- Distribute rewards on a weekly cadence (offchain ledger or onchain batch).
- Provide admin auditability for weekly payouts.

### 5) Persistence Layer
Data to persist:
- Accounts (wallet address, display name, session metadata)
- Player upgrades (permanent)
- Banked $ROACH (safe balance)
- Audit log for credits and withdrawals

Not persisted (live-only):
- Moment-to-moment room state (positions, HP) to reduce writes.

### 6) Admin Console
Responsibilities:
- View balances, banked $ROACH, recent deaths, mint events
- Manual withdrawal tooling (EOW)
- Emergency controls (pause rooms, scale bots)

## Data Model (Minimal)
- `Account`: id, wallet, created_at
- `Profile`: account_id, display_name
- `Balance`: account_id, banked_roach, spendable_roach, unowned_roach
- `Upgrade`: account_id, boot_size, multi_stomp, rate_of_fire
- `PaymentEvent`: tx_hash, account_id, amount, credited_at
- `Withdrawal`: account_id, amount, status, requested_at, processed_at
- `Distribution`: period_start, period_end, amount, status, processed_at

## Ownership & Economy Rules (Clarified)
- Players can stomp and earn while unminted; earnings are recorded as `unowned_roach`.
- Unowned earnings are not withdrawable or bankable until a mint occurs.
- Once a player mints, `unowned_roach` is promoted to spendable/banked based on game rules.
- If an unminted player stomps another roach, the purchase reward routes to the house.

## Game Loop (Authoritative)
1) Receive inputs for the tick window.
2) Apply movement with rubber-band modifier.
3) Resolve stomps vs hitboxes.
4) Apply HP changes, death penalty, respawn timers.
5) Update economy (passive income, motel banking).
6) Spawn/despawn bots based on room wealth.
7) Emit state delta to connected clients.

## Anti-Cheat Baseline
- Server authority on all combat/economy.
- Input validation: max move speed, stomp rate, input frequency.
- Room transition rules enforced on server.
- Optionally throttle anonymous inputs per IP/session.

## Scaling Strategy
Phase 1 (MVP):
- Single game server instance.
- All rooms in-memory.
- WebSockets handled by the same node process.

Phase 2 (Growth):
- Multiple game server instances with room sharding.
- Shared presence registry (Redis) for routing.
- Payment/indexer as separate service.

Phase 3 (Scale):
- Horizontal room shards with consistent hashing.
- Read replicas for analytics and leaderboards.
- Edge caching for assets and client bundles.

## Deployment Notes
- Deploy as a web app + game server + indexer service.
- Use HTTPS + secure WebSockets (WSS).
- Use a CDN for assets (sprites, audio).
- Base chain RPC provider for indexing.
 - Node/TS stack for the server and indexer.

## Open Questions
- Exact chain/payment provider for Base and wallet UX.
- How anonymous sessions map to wallets after minting.
- Timelock withdrawal flow (duration and UI).
- Handling abuse (botting, multi-account farming).

## Suggested MVP Cut (v1)
- Authoritative server + WebSocket transport
- One room shard (3x3)
- Minting offchain with Base $1 withdrawal event
- Play-before-mint flow with `unowned_roach`
- Manual withdrawals via admin console
- No NFTs, no onchain roach state

## Next Steps
- Pick stack (Node/TS vs Go/Rust) for server tick loop.
- Define protocol schema (message formats).
- Implement minimal indexer for Base mint events.
- Build admin console for withdrawals and ops.
