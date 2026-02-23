# Weekly $ROACH Airdrop Automation Plan

## Current architecture impact points

- **Banked balances live in `players.banked_balance`** and are updated whenever motel save completes. This is the canonical field for weekly payout input.
- **Live unbanked balance lives in `sessions.balance` / in-memory roach state** and should not be part of weekly payout unless product rules change.
- **Wallet destination is `players.wallet_address`** (already used by payments flow).

## Required weekly flow

1. Lock all rows where `players.banked_balance > 0`.
2. Build payout snapshot from players with both positive `banked_balance` and valid `wallet_address`.
3. Compute cap-safe scaling factor:
   - Total supply = `1,000,000,000`.
   - Max weekly airdrop = `2.5%` = `25,000,000` tokens.
   - `scaleFactor = min(1, 25_000_000 / totalRequested)`.
4. Insert immutable run ledger (`airdrop_runs` + `airdrop_run_items`) before any transfer.
5. **Immediately zero out `players.banked_balance` in the same DB transaction** (meets “zeroed out once airdrop initiated”).
6. Commit transaction.
7. Send ERC20 transfers from server key account.
8. Mark each item `sent`/`failed` with tx hash/error.

## Implemented script

`server/weekly-airdrop.js` now performs the above and supports:

- `--dry-run` mode (creates a dry run record, no zeroing, no on-chain sends)
- real run mode (requires RPC URL, private key, token address)
- automatic run/item table creation if missing
- per-player transfer status tracking

### Environment

- `DATABASE_URL`
- `AIRDROP_RPC_URL` (real run only)
- `AIRDROP_PRIVATE_KEY` (real run only)
- `ROACH_TOKEN_ADDRESS` (real run only)

### Commands

```bash
# review totals and scaling without changing balances
node server/weekly-airdrop.js --dry-run

# execute weekly run
node server/weekly-airdrop.js
```

## Emissions sidequest: max output estimates

Using current baseline passive emission constant:

- `INCOME_RATE = 0.10 ROACH/sec/player`
- Seconds per week = `604,800`
- Per-player/week baseline = `60,480 ROACH`

Raw weekly output if everyone remains active and banks all of it:

- **100 users**: `6,048,000 ROACH/week`
- **1,000 users**: `60,480,000 ROACH/week`
- **10,000 users**: `604,800,000 ROACH/week`

With the 2.5% weekly cap (`25,000,000`) enforced by scaling:

- **100 users**: no scaling needed (all `6,048,000` can be paid)
- **1,000 users**: scaled to cap (average `25,000` per user if balances equal)
- **10,000 users**: scaled to cap (average `2,500` per user if balances equal)

## Important note on true max emissions

`idleIncome` upgrades add additional minted income in active sessions. At max level, this can far exceed baseline passive output, so real weekly requests can be much higher than the baseline estimates above. The run-time scaling in the script is therefore the main safety rail.
