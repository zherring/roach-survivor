import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { GameServer } from './game-server.js';
import { db, initDB } from './db.js';
import { verifyUSDCTransfer } from './payment-verifier.js';
import {
  BASE_CHAIN_ID,
  PAYMENT_STAMPEDE_GRACE_PLAYERS,
  PAYMENT_RECIPIENT_ADDRESS,
  getGraceAdjustedPriceForPlayerCount,
  getPriceForPlayerCount,
  normalizeAddress,
} from './payment-config.js';
import {
  SIWE_SESSION_COOKIE_NAME,
  createSiweChallenge,
  createSiweSessionId,
  getRequestOrigin,
  normalizeSiweSessionId,
  verifySiweChallenge,
} from './siwe.js';

const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 8000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 16) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function getApiHeaders({ cors = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
  }
  return headers;
}

function parseCookies(req) {
  const raw = String(req.headers.cookie || '');
  const cookies = {};
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function buildSessionCookie(req, value) {
  const secure = getRequestOrigin(req).uri.startsWith('https://');
  const attrs = [
    `${SIWE_SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=1800',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

function isSensitiveApiPath(pathname) {
  return pathname === '/api/siwe/challenge'
    || pathname === '/api/siwe/verify'
    || pathname === '/api/verify-payment'
    || pathname === '/api/wallet-paid-status';
}

function isSameOriginRequest(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  const { uri } = getRequestOrigin(req);
  return origin === uri;
}

function rejectCrossOrigin(req, res) {
  if (isSameOriginRequest(req)) return false;
  res.writeHead(403, getApiHeaders());
  res.end(JSON.stringify({ error: 'Cross-origin request blocked' }));
  return true;
}

const server = http.createServer(async (req, res) => {
  // Parse URL to strip query strings
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const urlPath = parsedUrl.pathname;

  const apiHeaders = getApiHeaders({ cors: !isSensitiveApiPath(urlPath) });

  if (req.method === 'OPTIONS' && urlPath.startsWith('/api/')) {
    res.writeHead(204, apiHeaders);
    res.end();
    return;
  }

  // GET /api/wallet-paid-status — check whether wallet already owns a paid account
  if (urlPath === '/api/wallet-paid-status' && req.method === 'GET') {
    if (rejectCrossOrigin(req, res)) return;
    const walletAddress = parsedUrl.searchParams.get('walletAddress') || '';
    const normalizedWallet = normalizeAddress(walletAddress);
    if (!normalizedWallet) {
      res.writeHead(400, apiHeaders);
      res.end(JSON.stringify({ error: 'Invalid wallet address' }));
      return;
    }
    try {
      const player = await db.getPaidPlayerByWallet(normalizedWallet);
      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify({
        walletAddress: normalizedWallet,
        hasPaidAccount: !!player,
        playerName: player?.name || null,
      }));
    } catch (err) {
      console.error('Wallet status API error:', err.message);
      res.writeHead(500, apiHeaders);
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // POST /api/siwe/challenge — issue a short-lived challenge message for wallet re-auth
  if (urlPath === '/api/siwe/challenge' && req.method === 'POST') {
    if (rejectCrossOrigin(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const walletAddress = body?.walletAddress;
      const cookies = parseCookies(req);
      let sessionId = normalizeSiweSessionId(cookies[SIWE_SESSION_COOKIE_NAME]);
      let shouldSetSessionCookie = false;
      if (!sessionId) {
        sessionId = createSiweSessionId();
        shouldSetSessionCookie = true;
      }

      const created = createSiweChallenge(req, walletAddress, sessionId);
      if (!created.ok) {
        res.writeHead(created.status || 400, apiHeaders);
        res.end(JSON.stringify({ error: created.error || 'Failed to create challenge' }));
        return;
      }
      if (shouldSetSessionCookie) {
        res.setHeader('Set-Cookie', buildSessionCookie(req, sessionId));
      }
      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify(created.challenge));
    } catch (err) {
      console.error('SIWE challenge error:', err.message);
      const status = err instanceof SyntaxError ? 400 : 500;
      res.writeHead(status, apiHeaders);
      res.end(JSON.stringify({ error: status === 400 ? 'Invalid request body' : 'Internal error' }));
    }
    return;
  }

  // POST /api/siwe/verify — verify wallet signature and return paid account token
  if (urlPath === '/api/siwe/verify' && req.method === 'POST') {
    if (rejectCrossOrigin(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const cookies = parseCookies(req);
      const sessionId = normalizeSiweSessionId(cookies[SIWE_SESSION_COOKIE_NAME]);
      const verification = verifySiweChallenge({
        walletAddress: body?.walletAddress,
        nonce: body?.nonce,
        signature: body?.signature,
        sessionId,
        requestOrigin: getRequestOrigin(req).uri,
      });
      if (!verification.ok) {
        res.writeHead(verification.status || 400, apiHeaders);
        res.end(JSON.stringify({ error: verification.error || 'Invalid SIWE verification' }));
        return;
      }

      const player = await db.getPaidPlayerByWallet(verification.walletAddress);
      if (!player) {
        res.writeHead(404, apiHeaders);
        res.end(JSON.stringify({ error: 'No paid account found for this wallet' }));
        return;
      }

      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify({
        success: true,
        token: player.id,
        name: player.name,
        isPaid: true,
      }));
    } catch (err) {
      console.error('SIWE verify error:', err.message);
      const status = err instanceof SyntaxError ? 400 : 500;
      res.writeHead(status, apiHeaders);
      res.end(JSON.stringify({ error: status === 400 ? 'Invalid request body' : 'Internal error' }));
    }
    return;
  }

  // GET /api/payment-price (or legacy /api/pricing) — public pricing + recipient info
  if ((urlPath === '/api/payment-price' || urlPath === '/api/pricing') && req.method === 'GET') {
    try {
      if (!PAYMENT_RECIPIENT_ADDRESS) {
        res.writeHead(500, apiHeaders);
        res.end(JSON.stringify({ error: 'PAYMENT_RECIPIENT_ADDRESS is not configured' }));
        return;
      }
      const paidCount = await db.getPaidPlayerCount();
      const strictPrice = getPriceForPlayerCount(paidCount);
      const price = getGraceAdjustedPriceForPlayerCount(paidCount);
      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify({
        price,
        strictPrice,
        paidCount,
        recipientAddress: PAYMENT_RECIPIENT_ADDRESS,
        chainId: BASE_CHAIN_ID,
        currency: 'USDC',
        stampedeGracePlayers: PAYMENT_STAMPEDE_GRACE_PLAYERS,
      }));
    } catch (err) {
      console.error('Pricing API error:', err.message);
      res.writeHead(500, apiHeaders);
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // POST /api/verify-payment — verify USDC tx and mark player paid
  if (urlPath === '/api/verify-payment' && req.method === 'POST') {
    if (rejectCrossOrigin(req, res)) return;
    try {
      const body = JSON.parse(await readBody(req));
      const { txHash, playerId, walletAddress } = body;

      if (
        !txHash || typeof txHash !== 'string'
        || !playerId || typeof playerId !== 'string'
        || !walletAddress || typeof walletAddress !== 'string'
      ) {
        res.writeHead(400, apiHeaders);
        res.end(JSON.stringify({ error: 'Missing txHash, playerId, or walletAddress' }));
        return;
      }

      if (!PAYMENT_RECIPIENT_ADDRESS) {
        res.writeHead(500, apiHeaders);
        res.end(JSON.stringify({ error: 'PAYMENT_RECIPIENT_ADDRESS is not configured' }));
        return;
      }

      const normalizedWallet = normalizeAddress(walletAddress);
      if (!normalizedWallet) {
        res.writeHead(400, apiHeaders);
        res.end(JSON.stringify({ error: 'Invalid wallet address' }));
        return;
      }

      // Check player exists
      const player = await db.getPlayer(playerId);
      if (!player) {
        res.writeHead(404, apiHeaders);
        res.end(JSON.stringify({ error: 'Player not found' }));
        return;
      }

      const existingWalletOwner = await db.getPaidPlayerByWallet(normalizedWallet);
      if (existingWalletOwner && existingWalletOwner.id !== playerId) {
        res.writeHead(409, apiHeaders);
        res.end(JSON.stringify({ error: 'Wallet already linked to another paid account' }));
        return;
      }

      // Already paid
      if (player.paid_account) {
        res.writeHead(200, apiHeaders);
        res.end(JSON.stringify({ success: true, isPaid: true, alreadyPaid: true }));
        return;
      }

      // Replay protection
      if (await db.isPaymentProcessed(txHash)) {
        res.writeHead(400, apiHeaders);
        res.end(JSON.stringify({ error: 'Transaction already used' }));
        return;
      }

      // Get expected price
      const paidCount = await db.getPaidPlayerCount();
      const expectedPrice = getGraceAdjustedPriceForPlayerCount(paidCount);

      // Verify on-chain
      const result = await verifyUSDCTransfer({
        txHash,
        sender: normalizedWallet,
        recipient: PAYMENT_RECIPIENT_ADDRESS,
        minAmountUSDC: expectedPrice,
      });

      if (!result.valid) {
        res.writeHead(400, apiHeaders);
        res.end(JSON.stringify({ error: result.reason }));
        return;
      }

      // Mark paid
      const markResult = await db.markPaid(playerId, {
        txHash,
        amountUsdc: result.amountUSDC,
        chainId: BASE_CHAIN_ID,
        fromAddress: result.sender,
        recipientAddress: result.recipient,
        walletAddress: normalizedWallet,
      });

      // Notify the game server so the player gets updated state immediately
      if (!markResult.alreadyPaid) {
        gameServer.markPlayerPaid(playerId);
      }

      res.writeHead(200, apiHeaders);
      res.end(JSON.stringify({
        success: true,
        isPaid: true,
        alreadyPaid: !!markResult.alreadyPaid,
        amountUSDC: result.amountUSDC,
        paidCount: markResult.paidCount,
      }));
    } catch (err) {
      console.error('Verify payment error:', err.message);
      if (err && err.code === '23505') {
        res.writeHead(400, apiHeaders);
        res.end(JSON.stringify({ error: 'Transaction already used' }));
        return;
      }
      if (err && err.code === 'WALLET_ALREADY_LINKED') {
        res.writeHead(409, apiHeaders);
        res.end(JSON.stringify({ error: 'Wallet already linked to another paid account' }));
        return;
      }
      res.writeHead(500, apiHeaders);
      res.end(JSON.stringify({ error: 'Verification failed' }));
    }
    return;
  }

  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  let filePath;
  if (urlPath === '/' || urlPath === '/index.html') {
    filePath = path.join(ROOT, 'client', 'index.html');
  } else if (urlPath === '/shared/constants.js') {
    filePath = path.join(ROOT, 'shared', 'constants.js');
  } else if (urlPath.startsWith('/.well-known/')) {
    // Serve .well-known files from client/.well-known/
    filePath = path.join(ROOT, 'client', urlPath);
  } else {
    // Serve from client/
    filePath = path.join(ROOT, 'client', urlPath);
  }

  // Prevent directory traversal — must be under client/ or shared/constants.js
  const CLIENT_DIR = path.join(ROOT, 'client');
  const SHARED_FILE = path.join(ROOT, 'shared', 'constants.js');
  if (!filePath.startsWith(CLIENT_DIR + path.sep) && filePath !== SHARED_FILE) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  // CORS headers for miniapp contexts
  const headers = {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const gameServer = new GameServer();
let isShuttingDown = false;
const pendingRemovals = new Set();

wss.on('connection', (ws) => {
  if (isShuttingDown) {
    ws.close(1012, 'Server shutting down');
    return;
  }

  let playerId = null;
  let initialized = false;

  // Set a timeout — if no message arrives within 1s, add as new player
  const initTimeout = setTimeout(() => {
    if (!initialized && !isShuttingDown) {
      initialized = true;
      gameServer.addPlayer(ws).then(id => {
        playerId = id;
      }).catch(err => console.error('Failed to add player on timeout:', err.message));
    }
  }, 1000);

  ws.on('message', async (data) => {
    try {
      if (isShuttingDown) return;

      const msg = JSON.parse(data);

      // First message: check for reconnect token and/or platform identity
      if (!initialized) {
        initialized = true;
        clearTimeout(initTimeout);

        // Extract platform info if provided
        let platformInfo = null;
        if (msg.platformType && typeof msg.platformType === 'string'
            && msg.platformId && typeof msg.platformId === 'string') {
          platformInfo = {
            platformType: msg.platformType.slice(0, 32),
            platformId: msg.platformId.slice(0, 256),
            name: typeof msg.platformName === 'string' ? msg.platformName.slice(0, 64) : null,
          };
        }

        if (msg.type === 'reconnect' && typeof msg.token === 'string') {
          playerId = await gameServer.addPlayer(ws, msg.token, platformInfo);
        } else {
          playerId = await gameServer.addPlayer(ws, null, platformInfo);
          // Process this first message normally too
          if (playerId) await gameServer.handleMessage(playerId, msg);
        }
        return;
      }

      if (playerId) {
        await gameServer.handleMessage(playerId, msg);
      }
    } catch (e) {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    clearTimeout(initTimeout);
    if (!playerId || isShuttingDown) return;

    let removalPromise;
    removalPromise = gameServer.removePlayer(playerId)
      .catch(err => console.error('removePlayer error:', err?.message || err))
      .finally(() => {
        pendingRemovals.delete(removalPromise);
      });
    pendingRemovals.add(removalPromise);
  });
});

// Graceful shutdown
async function shutdown(signal = 'unknown', exitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  const uptimeSec = Math.round(process.uptime());
  const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
  console.log(`Shutting down (${signal})... uptime=${uptimeSec}s rss=${rssMb}MB`);

  gameServer.stop();

  // Persist active sessions before disconnecting clients.
  try {
    await Promise.race([
      gameServer.saveSessions(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('saveSessions timeout')), SHUTDOWN_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.error('Shutdown saveSessions error:', err?.message || err);
  }

  // Stop accepting traffic after state is persisted.
  await Promise.race([
    new Promise(resolve => wss.close(() => resolve())),
    new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);
  await Promise.race([
    new Promise(resolve => server.close(() => resolve())),
    new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
  ]);

  // Flush any disconnect removals that started before shutdown.
  if (pendingRemovals.size > 0) {
    try {
      await Promise.race([
        Promise.allSettled([...pendingRemovals]),
        new Promise((_, reject) => setTimeout(() => reject(new Error('removePlayer flush timeout')), SHUTDOWN_TIMEOUT_MS)),
      ]);
    } catch (err) {
      console.error('Shutdown removePlayer flush error:', err?.message || err);
    }
  }

  try {
    await Promise.race([
      db.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('db.close timeout')), SHUTDOWN_TIMEOUT_MS)),
    ]);
  } catch (err) {
    console.error('Shutdown db.close error:', err?.message || err);
  }

  console.log('Shutdown complete. Exiting.');
  process.exit(exitCode);
}
process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err?.stack || err?.message || err);
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Initialize DB, then start
(async () => {
  await initDB();
  await gameServer.init();
  gameServer.start();
  server.listen(PORT, () => {
    console.log(`$ROACH server running on http://localhost:${PORT}`);
  });
})();
