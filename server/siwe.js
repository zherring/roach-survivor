import { randomBytes } from 'crypto';
import { verifyMessage } from 'ethers';
import { BASE_CHAIN_ID, normalizeAddress } from './payment-config.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SIWE_STATEMENT = 'Sign in to recover your paid $ROACH account.';

const challenges = new Map();

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(req.headers.host || '').trim();
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  return {
    domain: host,
    uri: host ? `${protocol}://${host}` : `${protocol}://localhost`,
  };
}

function buildSiweMessage({
  domain,
  address,
  uri,
  nonce,
  issuedAt,
  expirationTime,
}) {
  return `${domain} wants you to sign in with your Ethereum account:
${address}

${SIWE_STATEMENT}

URI: ${uri}
Version: 1
Chain ID: ${BASE_CHAIN_ID}
Nonce: ${nonce}
Issued At: ${issuedAt}
Expiration Time: ${expirationTime}`;
}

function sweepExpiredChallenges(now = Date.now()) {
  for (const [nonce, challenge] of challenges.entries()) {
    if (challenge.expiresAt <= now) {
      challenges.delete(nonce);
    }
  }
}

export function createSiweChallenge(req, walletAddress) {
  const normalized = normalizeAddress(walletAddress);
  if (!normalized) {
    return { ok: false, status: 400, error: 'Invalid wallet address' };
  }

  sweepExpiredChallenges();

  const nonce = randomBytes(16).toString('hex');
  const issuedAtDate = new Date();
  const expiresAtDate = new Date(issuedAtDate.getTime() + CHALLENGE_TTL_MS);
  const { domain, uri } = getRequestOrigin(req);
  const message = buildSiweMessage({
    domain,
    address: normalized,
    uri,
    nonce,
    issuedAt: issuedAtDate.toISOString(),
    expirationTime: expiresAtDate.toISOString(),
  });

  challenges.set(nonce, {
    walletAddress: normalized,
    message,
    expiresAt: expiresAtDate.getTime(),
  });

  return {
    ok: true,
    challenge: {
      nonce,
      message,
      expiresAt: expiresAtDate.toISOString(),
    },
  };
}

export function verifySiweChallenge({ walletAddress, nonce, signature }) {
  const normalized = normalizeAddress(walletAddress);
  if (!normalized) {
    return { ok: false, status: 400, error: 'Invalid wallet address' };
  }
  if (!nonce || typeof nonce !== 'string') {
    return { ok: false, status: 400, error: 'Missing nonce' };
  }
  if (!signature || typeof signature !== 'string') {
    return { ok: false, status: 400, error: 'Missing signature' };
  }

  sweepExpiredChallenges();
  const challenge = challenges.get(nonce);
  if (!challenge) {
    return { ok: false, status: 400, error: 'Challenge expired or not found' };
  }
  if (challenge.walletAddress !== normalized) {
    challenges.delete(nonce);
    return { ok: false, status: 400, error: 'Challenge wallet mismatch' };
  }
  if (challenge.expiresAt <= Date.now()) {
    challenges.delete(nonce);
    return { ok: false, status: 400, error: 'Challenge expired' };
  }

  try {
    const recoveredAddress = normalizeAddress(verifyMessage(challenge.message, signature));
    challenges.delete(nonce);
    if (!recoveredAddress || recoveredAddress !== normalized) {
      return { ok: false, status: 401, error: 'Signature does not match wallet' };
    }
    return { ok: true, walletAddress: recoveredAddress };
  } catch (err) {
    challenges.delete(nonce);
    return {
      ok: false,
      status: 401,
      error: `Invalid signature: ${err.message || 'verification failed'}`,
    };
  }
}
