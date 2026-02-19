# $ROACH Smart Contracts (Foundry)

This folder contains a minimal, secure ERC20 setup for `$ROACH`, using OpenZeppelin contracts and Foundry.

## Contract

- `src/RoachToken.sol`
  - OpenZeppelin `ERC20`
  - Fixed initial supply: `1,000,000,000 ROACH` (18 decimals)
  - Constructor mints **100% of supply** to the address you pass in at deploy time
  - **No owner/admin functions** (no mint, no pause, no blacklist, no admin withdrawal)

## Setup

From this folder:

```bash
forge install OpenZeppelin/openzeppelin-contracts foundry-rs/forge-std
```

## Test

```bash
forge test
```

## Deploy

Set your deployer private key and target mint address:

```bash
export PRIVATE_KEY=0x...
export MINT_TO=0x...
```

Dry run:

```bash
forge script script/DeployRoachToken.s.sol:DeployRoachToken
```

Broadcast example:

```bash
forge script script/DeployRoachToken.s.sol:DeployRoachToken \
  --rpc-url $RPC_URL \
  --broadcast
```

When you share the final mint address, use that value for `MINT_TO` and we can deploy with 100% minted there.
