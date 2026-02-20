# $ROACH Token Launch Checklist (Base Mainnet)

This checklist reflects the current plan:
- Team-deployed ERC20 (not Clanker)
- 10% manually seeded LP
- 90% treasury in 2/3 multisig
- 1-month Hedgey linear stream for treasury operations

## 1. Preflight

- Confirm signer set for treasury multisig is final (2/3) and tested with a small tx.
- Freeze token metadata before deploy:
  - `name`: `ROACH`
  - `symbol`: `ROACH`
  - `decimals`: `18` (OpenZeppelin default)
- Confirm deployment target is Base mainnet (`chainId=8453`).
- Confirm env vars:
  - `PRIVATE_KEY` = deployer key (secure, hardware-backed if possible)
  - `MINT_TO` = treasury multisig address
  - `RPC_URL` = trusted Base RPC

## 2. Contract Validation

From `smart-contracts/`:

```bash
forge test -vv
forge script script/DeployRoachToken.s.sol:DeployRoachToken
```

- Verify dry run uses expected `MINT_TO`.
- Confirm total supply and recipient expectations match plan.

## 3. Mainnet Deploy

```bash
forge script script/DeployRoachToken.s.sol:DeployRoachToken \
  --rpc-url $RPC_URL \
  --broadcast
```

- Record deployed token address.
- Verify source on BaseScan.
- Save tx hash + deployment block in internal launch notes.

## 4. Treasury Allocation Execution

Execute from treasury multisig:

1. Allocate **10%** of total supply for liquidity.
2. Keep **90%** in treasury custody.
3. Create manual LP position with your chosen custom range/structure.
4. Create Hedgey 1-month linear stream for treasury operations from multisig-held allocation.
5. Archive all tx hashes and signer approvals.

## 5. App Integration

- Set token address in backend/operator configs.
- Run end-to-end payment + payout dry run with production addresses.
- Validate payout math and decimals handling before first real distribution.

## 6. Ops Guardrails

- Publish canonical token address in docs and UI.
- Add internal incident playbook:
  - Pause payouts manually if anomalies are detected
  - Communicate status + next steps publicly

## 7. Important Immutability Note

For current `smart-contracts/src/RoachToken.sol`, **ticker/symbol cannot be changed after deployment**.

- There is no owner setter for `name` or `symbol`.
- If you need `DEPRECATED` or a new ticker later, deploy a new token and migrate messaging/integration to the new address.
- Recommended deprecation pattern:
  1. Freeze old-token payouts in app ops
  2. Mark old token as deprecated in UI/docs/token list metadata
  3. Point all app logic + comms to new token address

