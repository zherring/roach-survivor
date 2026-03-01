import 'dotenv/config';
import { ethers } from 'ethers';
import { db, initDB } from '../db.js';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const TOKEN_ADDRESS = process.env.ROACH_TOKEN_ADDRESS;
const PRIVATE_KEY = process.env.ROACH_PAYOUT_PRIVATE_KEY;
const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.ROACH_PAYOUT_DRY_RUN || '').toLowerCase());
const ONLY_PAID = ['1', 'true', 'yes'].includes(String(process.env.ROACH_PAYOUT_ONLY_PAID || '').toLowerCase());
const MIN_AMOUNT = Number(process.env.ROACH_PAYOUT_MIN_AMOUNT || 0);
const MAX_PLAYERS = Number.isFinite(Number(process.env.ROACH_PAYOUT_MAX_PLAYERS))
  ? Number(process.env.ROACH_PAYOUT_MAX_PLAYERS)
  : Infinity;
const CONFIRMATIONS = Math.max(1, Number(process.env.ROACH_PAYOUT_CONFIRMATIONS || 1));

function assertConfig() {
  if (!TOKEN_ADDRESS || !ethers.isAddress(TOKEN_ADDRESS)) {
    throw new Error('ROACH_TOKEN_ADDRESS is required and must be a valid address');
  }
  if (!DRY_RUN && (!PRIVATE_KEY || !/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY))) {
    throw new Error('ROACH_PAYOUT_PRIVATE_KEY is required for non-dry-run mode');
  }
  if (!Number.isFinite(MIN_AMOUNT) || MIN_AMOUNT < 0) {
    throw new Error('ROACH_PAYOUT_MIN_AMOUNT must be a non-negative number');
  }
}

function amountToChainUnits(amount, decimals) {
  const fixed = Number(amount).toFixed(Math.min(decimals, 8));
  return ethers.parseUnits(fixed, decimals);
}

async function loadEligiblePlayers(limit) {
  const { rows } = await db.query(
    `SELECT id, name, wallet_address, banked_balance, paid_account
     FROM players
     WHERE banked_balance > $1
       AND wallet_address IS NOT NULL
       AND btrim(wallet_address) <> ''
       ${ONLY_PAID ? 'AND paid_account = TRUE' : ''}
     ORDER BY banked_balance DESC
     LIMIT $2`,
    [MIN_AMOUNT, limit]
  );
  return rows.filter((player) => ethers.isAddress(player.wallet_address));
}

async function payoutPlayer({ player, token, decimals }) {
  const amount = Number(player.banked_balance || 0);
  const chainAmount = amountToChainUnits(amount, decimals);
  if (chainAmount <= 0n) {
    return { status: 'skipped', reason: 'amount rounds to 0 on-chain' };
  }

  const tx = await token.transfer(player.wallet_address, chainAmount);
  const receipt = await tx.wait(CONFIRMATIONS);

  await db.query(
    `UPDATE players
     SET banked_balance = 0,
         last_seen = $1
     WHERE id = $2`,
    [Date.now(), player.id]
  );

  return {
    status: 'paid',
    txHash: receipt.hash,
    amount,
    wallet: player.wallet_address,
  };
}

async function main() {
  assertConfig();
  await initDB();

  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
  const signer = DRY_RUN
    ? null
    : new ethers.Wallet(PRIVATE_KEY, provider);
  const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, signer || provider);

  let decimals = Number(process.env.ROACH_TOKEN_DECIMALS || NaN);
  if (!Number.isFinite(decimals)) {
    decimals = Number(await token.decimals());
  }
  const symbol = await token.symbol().catch(() => 'TOKEN');

  const effectiveLimit = Number.isFinite(MAX_PLAYERS) ? Math.max(0, Math.floor(MAX_PLAYERS)) : 100000;
  const players = await loadEligiblePlayers(effectiveLimit);

  if (players.length === 0) {
    console.log('No players eligible for payout.');
    return;
  }

  console.log(`Starting ${DRY_RUN ? 'dry run ' : ''}payout for ${players.length} player(s).`);
  console.log(`Token: ${TOKEN_ADDRESS} (${symbol}), decimals: ${decimals}`);
  if (ONLY_PAID) {
    console.log('Filtering to paid_account = true players only.');
  }

  const summary = {
    paid: 0,
    skipped: 0,
    failed: 0,
    totalAmount: 0,
  };

  for (const player of players) {
    const amount = Number(player.banked_balance || 0);
    const display = `${amount.toFixed(4)} ${symbol}`;
    try {
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would pay ${display} to ${player.name} (${player.id}) -> ${player.wallet_address}`);
        summary.paid += 1;
        summary.totalAmount += amount;
        continue;
      }

      const result = await payoutPlayer({ player, token, decimals });
      if (result.status === 'paid') {
        console.log(`Paid ${display} to ${player.name} (${player.id}) in tx ${result.txHash}`);
        summary.paid += 1;
        summary.totalAmount += amount;
      } else {
        console.log(`Skipped ${player.name} (${player.id}): ${result.reason}`);
        summary.skipped += 1;
      }
    } catch (err) {
      summary.failed += 1;
      console.error(`Failed payout for ${player.name} (${player.id}):`, err.message);
    }
  }

  console.log('Payout complete:', summary);
}

main()
  .catch((err) => {
    console.error('Payout script failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
