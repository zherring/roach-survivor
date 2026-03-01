# Scripts

## Weekly $ROACH payout

Run:

```bash
npm run payout:roach
```

Environment variables used by `payout-roach-rewards.js`:

- `DATABASE_URL` (required)
- `ROACH_TOKEN_ADDRESS` (required)
- `ROACH_PAYOUT_PRIVATE_KEY` (required unless `ROACH_PAYOUT_DRY_RUN=true`)
- `BASE_RPC_URL` (optional, default `https://mainnet.base.org`)
- `ROACH_TOKEN_DECIMALS` (optional, auto-detected from token if omitted)
- `ROACH_PAYOUT_DRY_RUN` (optional, `true`/`false`)
- `ROACH_PAYOUT_ONLY_PAID` (optional, only include `paid_account=true` players)
- `ROACH_PAYOUT_MIN_AMOUNT` (optional, default `0`)
- `ROACH_PAYOUT_MAX_PLAYERS` (optional, default no limit)
- `ROACH_PAYOUT_CONFIRMATIONS` (optional, default `1`)

Behavior:

1. Finds players with `banked_balance > ROACH_PAYOUT_MIN_AMOUNT` and a valid `wallet_address`.
2. Sends each wallet their full banked balance in `$ROACH`.
3. On successful transfer confirmation, sets that player `banked_balance` to `0`.

Recommended first run:

```bash
ROACH_PAYOUT_DRY_RUN=true npm run payout:roach
```
