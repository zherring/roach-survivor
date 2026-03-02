# Scripts

## Weekly $ROACH payout

Run:

```bash
npm run payout:roach
```

Environment variables used by `payout-roach-rewards.js`:

- `DATABASE_URL` (required)
- `ROACH_TOKEN_ADDRESS` (required)
- `ROACH_PAYOUT_SOURCE_ADDRESS` (optional override; otherwise uses `PAYMENT_RECIPIENT_ADDRESS` or `TREASURY_ADDRESS`, and one of these must resolve to a valid address)
- `ROACH_PAYOUT_PRIVATE_KEY` (required unless `ROACH_PAYOUT_DRY_RUN=true`)
- `ROACH_PAYOUT_SPENDER_ADDRESS` (optional; only needed to validate allowance during dry runs when no private key is present)
- `BASE_RPC_URL` (optional, default `https://mainnet.base.org`)
- `ROACH_TOKEN_DECIMALS` (optional, auto-detected from token if omitted)
- `ROACH_PAYOUT_DRY_RUN` (optional, `true`/`false`)
- `ROACH_PAYOUT_ONLY_PAID` (optional, only include `paid_account=true` players)
- `ROACH_PAYOUT_MIN_AMOUNT` (optional, default `0`)
- `ROACH_PAYOUT_MAX_PLAYERS` (optional, default no limit)
- `ROACH_PAYOUT_CONFIRMATIONS` (optional, default `1`)

Behavior:

1. Finds players with `banked_balance > ROACH_PAYOUT_MIN_AMOUNT` and a valid `wallet_address`.
2. Checks the configured source address has enough `$ROACH` for the full batch.
3. If the signer differs from the source address, checks ERC20 allowance and pays each wallet with `transferFrom(source, wallet, amount)`.
4. If the signer is the source address, pays each wallet with a direct `transfer(wallet, amount)`.
5. On successful transfer confirmation, sets that player `banked_balance` to `0`.

Recommended first run:

```bash
ROACH_PAYOUT_DRY_RUN=true npm run payout:roach
```
