import 'dotenv/config';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { GameServer } from './game-server.js';
import { db, initDB } from './db.js';

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

const server = http.createServer((req, res) => {
  // Parse URL to strip query strings
  const urlPath = new URL(req.url, `http://${req.headers.host}`).pathname;

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
