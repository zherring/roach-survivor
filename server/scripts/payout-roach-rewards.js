import 'dotenv/config';
import { ethers } from 'ethers';
import { db, initDB } from '../db.js';
import { normalizeAddress } from '../payment-config.js';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];

const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const TOKEN_ADDRESS = process.env.ROACH_TOKEN_ADDRESS;
const PRIVATE_KEY = process.env.ROACH_PAYOUT_PRIVATE_KEY;
const SOURCE_ADDRESS = normalizeAddress(
  process.env.ROACH_PAYOUT_SOURCE_ADDRESS
    || process.env.PAYMENT_RECIPIENT_ADDRESS
    || process.env.TREASURY_ADDRESS
    || ''
);
const SPENDER_ADDRESS = normalizeAddress(process.env.ROACH_PAYOUT_SPENDER_ADDRESS || '');
const DRY_RUN = ['1', 'true', 'yes'].includes(String(process.env.ROACH_PAYOUT_DRY_RUN || '').toLowerCase());
const ONLY_PAID = ['1', 'true', 'yes'].includes(String(process.env.ROACH_PAYOUT_ONLY_PAID || '').toLowerCase());
const MIN_AMOUNT = Number(process.env.ROACH_PAYOUT_MIN_AMOUNT || 0);
const MAX_PLAYERS = Number.isFinite(Number(process.env.ROACH_PAYOUT_MAX_PLAYERS))
  ? Number(process.env.ROACH_PAYOUT_MAX_PLAYERS)
  : Infinity;
const CONFIRMATIONS = Math.max(1, Number(process.env.ROACH_PAYOUT_CONFIRMATIONS || 1));
const MAX_RETRIES = Math.max(0, Number(process.env.ROACH_PAYOUT_RETRY_ATTEMPTS || 2));
const RETRY_DELAY_MS = Math.max(0, Number(process.env.ROACH_PAYOUT_RETRY_DELAY_MS || 1500));

function assertConfig() {
  if (!TOKEN_ADDRESS || !ethers.isAddress(TOKEN_ADDRESS)) {
    throw new Error('ROACH_TOKEN_ADDRESS is required and must be a valid address');
  }
  if (!SOURCE_ADDRESS) {
    throw new Error('ROACH_PAYOUT_SOURCE_ADDRESS is required and must be a valid address');
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getSpenderAddress(signer) {
  if (!signer) return SPENDER_ADDRESS;
  try {
    return normalizeAddress(await signer.getAddress());
  } catch {
    return normalizeAddress(signer?.address || SPENDER_ADDRESS);
  }
}

function isRetryableNonceError(err) {
  const code = String(err?.code || '');
  const message = String(err?.message || '').toLowerCase();
  return code === 'NONCE_EXPIRED'
    || code === 'REPLACEMENT_UNDERPRICED'
    || message.includes('nonce too low')
    || message.includes('nonce has already been used')
    || message.includes('replacement transaction underpriced');
}

async function sendPayoutTransaction({ token, player, chainAmount, sourceAddress, spenderAddress }) {
  return sourceAddress === spenderAddress
    ? token.transfer(player.wallet_address, chainAmount)
    : token.transferFrom(sourceAddress, player.wallet_address, chainAmount);
}

async function payoutPlayer({ player, token, decimals, sourceAddress, spenderAddress, signer }) {
  const amount = Number(player.banked_balance || 0);
  const chainAmount = amountToChainUnits(amount, decimals);
  if (chainAmount <= 0n) {
    return { status: 'skipped', reason: 'amount rounds to 0 on-chain' };
  }

  let receipt;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const tx = await sendPayoutTransaction({
        token,
        player,
        chainAmount,
        sourceAddress,
        spenderAddress,
      });
      receipt = await tx.wait(CONFIRMATIONS);
      break;
    } catch (err) {
      const canRetry = attempt < MAX_RETRIES && isRetryableNonceError(err);
      if (!canRetry) throw err;

      if (signer && typeof signer.reset === 'function') {
        signer.reset();
      }
      const nextDelay = RETRY_DELAY_MS * (attempt + 1);
      console.warn(
        `Retrying payout for ${player.name} (${player.id}) after nonce error [attempt ${attempt + 1}/${MAX_RETRIES}]: ${err.message}`
      );
      if (nextDelay > 0) {
        await sleep(nextDelay);
      }
    }
  }

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
  const baseSigner = DRY_RUN
    ? null
    : new ethers.Wallet(PRIVATE_KEY, provider);
  const signer = baseSigner
    ? new ethers.NonceManager(baseSigner)
    : null;
  const token = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, signer || provider);
  const spenderAddress = await getSpenderAddress(signer);

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
  console.log(`Payout source: ${SOURCE_ADDRESS}`);
  if (spenderAddress) {
    console.log(`Payout signer/spender: ${spenderAddress}`);
  } else if (DRY_RUN) {
    console.log('Payout signer/spender unavailable in dry run; skipping allowance validation.');
  }
  if (signer) {
    console.log(`Starting signer nonce (pending): ${await signer.getNonce('pending')}`);
  }
  if (ONLY_PAID) {
    console.log('Filtering to paid_account = true players only.');
  }

  const payoutPlan = players.map((player) => ({
    player,
    amount: Number(player.banked_balance || 0),
    chainAmount: amountToChainUnits(player.banked_balance || 0, decimals),
  }));
  const totalChainAmount = payoutPlan.reduce((sum, entry) => sum + entry.chainAmount, 0n);
  const sourceBalance = await token.balanceOf(SOURCE_ADDRESS);
  if (sourceBalance < totalChainAmount) {
    throw new Error(
      `Source balance ${ethers.formatUnits(sourceBalance, decimals)} ${symbol} is below required payout total ${ethers.formatUnits(totalChainAmount, decimals)} ${symbol}`
    );
  }

  if (spenderAddress && spenderAddress !== SOURCE_ADDRESS) {
    const allowance = await token.allowance(SOURCE_ADDRESS, spenderAddress);
    console.log(`Allowance for signer on source: ${ethers.formatUnits(allowance, decimals)} ${symbol}`);
    if (allowance < totalChainAmount) {
      throw new Error(
        `Allowance ${ethers.formatUnits(allowance, decimals)} ${symbol} is below required payout total ${ethers.formatUnits(totalChainAmount, decimals)} ${symbol}`
      );
    }
  }

  const summary = {
    paid: 0,
    skipped: 0,
    failed: 0,
    totalAmount: 0,
  };

  for (const { player, amount } of payoutPlan) {
    const display = `${amount.toFixed(4)} ${symbol}`;
    try {
      if (DRY_RUN) {
        console.log(`[DRY RUN] Would pay ${display} to ${player.name} (${player.id}) -> ${player.wallet_address}`);
        summary.paid += 1;
        summary.totalAmount += amount;
        continue;
      }

      const result = await payoutPlayer({
        player,
        token,
        decimals,
        sourceAddress: SOURCE_ADDRESS,
        spenderAddress,
        signer,
      });
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
