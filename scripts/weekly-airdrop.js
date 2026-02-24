import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { initDB, db } from '../server/db.js';
import { BASE_RPC_URL, normalizeAddress } from '../server/payment-config.js';

dotenv.config();

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    execute: args.has('--execute'),
  };
}

function toTokenAmount(value, decimals) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return ethers.parseUnits(safe.toFixed(6), decimals);
}

function formatAmount(value) {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return Number(safe.toFixed(6));
}

function aggregateRecipients(candidates) {
  const byWallet = new Map();
  for (const row of candidates) {
    const wallet = row.wallet_address.trim().toLowerCase();
    const current = byWallet.get(wallet) || { wallet, total: 0, players: [] };
    current.total += Number(row.banked_balance || 0);
    current.players.push({
      id: row.id,
      name: row.name,
      banked: Number(row.banked_balance || 0),
    });
    byWallet.set(wallet, current);
  }
  return [...byWallet.values()].sort((a, b) => b.total - a.total);
}

async function main() {
  const { execute } = parseArgs(process.argv);
  await initDB();

  try {
    const candidates = await db.getWeeklyAirdropCandidates();
    const recipients = aggregateRecipients(candidates);

    if (recipients.length === 0) {
      console.log('No paid players with banked balance > 0. Nothing to airdrop.');
      return;
    }

    const totalToAirdrop = recipients.reduce((sum, entry) => sum + entry.total, 0);

    console.log(`Weekly airdrop recipients: ${recipients.length}`);
    console.log(`Total banked to airdrop: ${formatAmount(totalToAirdrop)}`);
    for (const entry of recipients) {
      console.log(`- ${entry.wallet}: ${formatAmount(entry.total)} (${entry.players.length} player account(s))`);
    }

    if (!execute) {
      console.log('\nDry run only. Re-run with --execute to send tokens and reset banked balances.');
      return;
    }

    const privateKey = process.env.AIRDROP_PRIVATE_KEY || '';
    const tokenAddress = process.env.ROACH_TOKEN_ADDRESS || '';
    const treasuryAddress = normalizeAddress(process.env.AIRDROP_TREASURY_ADDRESS || '');
    if (!privateKey || !tokenAddress || !treasuryAddress) {
      throw new Error('AIRDROP_PRIVATE_KEY, ROACH_TOKEN_ADDRESS, and AIRDROP_TREASURY_ADDRESS are required when using --execute');
    }

    const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || BASE_RPC_URL);
    const wallet = new ethers.Wallet(privateKey, provider);
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const [decimals, symbol] = await Promise.all([
      token.decimals(),
      token.symbol().catch(() => 'TOKEN'),
    ]);

    console.log(`Using treasury ${treasuryAddress} (spender signer: ${wallet.address.toLowerCase()})`);

    const successfulPlayerIds = [];
    let sentTotal = 0;

    for (const entry of recipients) {
      const amount = formatAmount(entry.total);
      if (amount <= 0) continue;

      const amountUnits = toTokenAmount(amount, decimals);
      try {
        const tx = await token.transferFrom(treasuryAddress, entry.wallet, amountUnits);
        const receipt = await tx.wait();
        console.log(`Sent ${amount} ${symbol} from ${treasuryAddress} to ${entry.wallet} (tx: ${receipt.hash})`);
        sentTotal += amount;
        successfulPlayerIds.push(...entry.players.map((p) => p.id));
      } catch (err) {
        console.error(`FAILED transferFrom ${treasuryAddress} -> ${entry.wallet}: ${err.message}`);
      }
    }

    const resetCount = await db.resetBankedBalances(successfulPlayerIds);
    console.log(`\nAirdrop complete. Sent ${formatAmount(sentTotal)} ${symbol}. Reset banked balances for ${resetCount} player account(s).`);

    if (resetCount !== successfulPlayerIds.length) {
      console.warn('Warning: reset count differs from successful payout player count.');
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
