import 'dotenv/config';
import pg from 'pg';
import { ethers } from 'ethers';

const TOTAL_SUPPLY = 1_000_000_000;
const WEEKLY_CAP_PERCENT = 0.025;
const WEEKLY_CAP_TOKENS = TOTAL_SUPPLY * WEEKLY_CAP_PERCENT;
const ERC20_ABI = [
  'function transfer(address to, uint256 value) external returns (bool)',
  'function decimals() view returns (uint8)',
];

function toNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeAddress(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return ethers.getAddress(trimmed);
  } catch {
    return null;
  }
}

function computePayouts(players) {
  const totalRequested = players.reduce((sum, p) => sum + p.bankedBalance, 0);
  const scale = totalRequested > WEEKLY_CAP_TOKENS ? WEEKLY_CAP_TOKENS / totalRequested : 1;

  let totalPayout = 0;
  const payouts = players.map((p) => {
    const payout = p.bankedBalance * scale;
    totalPayout += payout;
    return { ...p, payoutTokens: payout };
  });

  return {
    totalRequested,
    totalPayout,
    scale,
    payouts,
  };
}

async function ensureAirdropTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS airdrop_runs (
      id BIGSERIAL PRIMARY KEY,
      created_at BIGINT NOT NULL,
      status TEXT NOT NULL,
      total_players INTEGER NOT NULL,
      total_requested DOUBLE PRECISION NOT NULL,
      total_payout DOUBLE PRECISION NOT NULL,
      scale_factor DOUBLE PRECISION NOT NULL,
      cap_tokens DOUBLE PRECISION NOT NULL,
      notes TEXT DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS airdrop_run_items (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL REFERENCES airdrop_runs(id) ON DELETE CASCADE,
      player_id TEXT NOT NULL REFERENCES players(id),
      wallet_address TEXT NOT NULL,
      requested_balance DOUBLE PRECISION NOT NULL,
      payout_tokens DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      tx_hash TEXT DEFAULT NULL,
      error_message TEXT DEFAULT NULL,
      sent_at BIGINT DEFAULT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_airdrop_run_items_run_id ON airdrop_run_items (run_id);
    CREATE INDEX IF NOT EXISTS idx_airdrop_run_items_player_id ON airdrop_run_items (player_id);
  `);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  const client = await pool.connect();
  let runId = null;

  try {
    await client.query('BEGIN');
    await ensureAirdropTables(client);

    const { rows } = await client.query(
      `SELECT id, banked_balance, wallet_address
       FROM players
       WHERE banked_balance > 0
       FOR UPDATE`
    );

    const eligible = rows
      .map((r) => ({
        playerId: r.id,
        bankedBalance: toNumber(r.banked_balance),
        walletAddress: normalizeAddress(r.wallet_address),
      }))
      .filter((r) => r.bankedBalance > 0 && r.walletAddress);

    if (!eligible.length) {
      console.log('No eligible players found (requires positive banked_balance + valid wallet_address).');
      await client.query('ROLLBACK');
      return;
    }

    const summary = computePayouts(eligible);
    const now = Date.now();

    const runInsert = await client.query(
      `INSERT INTO airdrop_runs
       (created_at, status, total_players, total_requested, total_payout, scale_factor, cap_tokens, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        now,
        dryRun ? 'dry_run' : 'initiated',
        eligible.length,
        summary.totalRequested,
        summary.totalPayout,
        summary.scale,
        WEEKLY_CAP_TOKENS,
        dryRun ? 'Dry run - no balances zeroed and no on-chain transfers sent' : null,
      ]
    );
    runId = runInsert.rows[0].id;

    for (const item of summary.payouts) {
      await client.query(
        `INSERT INTO airdrop_run_items
         (run_id, player_id, wallet_address, requested_balance, payout_tokens, status)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, item.playerId, item.walletAddress, item.bankedBalance, item.payoutTokens, dryRun ? 'dry_run' : 'pending']
      );
    }

    if (!dryRun) {
      const playerIds = summary.payouts.map((p) => p.playerId);
      await client.query(
        'UPDATE players SET banked_balance = 0, last_seen = $1 WHERE id = ANY($2::text[])',
        [Date.now(), playerIds]
      );
    }

    await client.query('COMMIT');

    console.log(`Run ${runId} prepared. Eligible players: ${eligible.length}`);
    console.log(`Requested: ${summary.totalRequested.toFixed(2)} ROACH`);
    console.log(`Weekly cap: ${WEEKLY_CAP_TOKENS.toFixed(2)} ROACH`);
    console.log(`Scale factor: ${summary.scale.toFixed(8)}`);
    console.log(`Payout total: ${summary.totalPayout.toFixed(2)} ROACH`);

    if (dryRun) return;

    if (!process.env.AIRDROP_RPC_URL || !process.env.AIRDROP_PRIVATE_KEY || !process.env.ROACH_TOKEN_ADDRESS) {
      throw new Error('AIRDROP_RPC_URL, AIRDROP_PRIVATE_KEY, and ROACH_TOKEN_ADDRESS are required when not in --dry-run mode');
    }

    const provider = new ethers.JsonRpcProvider(process.env.AIRDROP_RPC_URL);
    const signer = new ethers.Wallet(process.env.AIRDROP_PRIVATE_KEY, provider);
    const token = new ethers.Contract(process.env.ROACH_TOKEN_ADDRESS, ERC20_ABI, signer);
    const decimals = await token.decimals();

    for (const item of summary.payouts) {
      try {
        const amount = ethers.parseUnits(item.payoutTokens.toFixed(18), decimals);
        const tx = await token.transfer(item.walletAddress, amount);
        await tx.wait();

        await pool.query(
          `UPDATE airdrop_run_items
           SET status = 'sent', tx_hash = $1, sent_at = $2
           WHERE run_id = $3 AND player_id = $4`,
          [tx.hash, Date.now(), runId, item.playerId]
        );
      } catch (err) {
        await pool.query(
          `UPDATE airdrop_run_items
           SET status = 'failed', error_message = $1
           WHERE run_id = $2 AND player_id = $3`,
          [err?.message || String(err), runId, item.playerId]
        );
      }
    }

    await pool.query(
      `UPDATE airdrop_runs
       SET status = (
         CASE
           WHEN EXISTS (SELECT 1 FROM airdrop_run_items WHERE run_id = $1 AND status = 'failed') THEN 'completed_with_failures'
           ELSE 'completed'
         END
       )
       WHERE id = $1`,
      [runId]
    );

    console.log(`Run ${runId} transfer phase completed.`);
  } catch (err) {
    if (runId) {
      await pool.query('UPDATE airdrop_runs SET status = $1, notes = COALESCE(notes, $2) WHERE id = $3', ['errored', err.message, runId]).catch(() => {});
    }
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Airdrop job failed:', err);
  process.exit(1);
});
