import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { GameServer } from './game-server.js';
import { db, initDB } from './db.js';

const PORT = process.env.PORT || 3000;
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

wss.on('connection', (ws) => {
  let playerId = null;
  let initialized = false;

  // Set a timeout — if no message arrives within 1s, add as new player
  const initTimeout = setTimeout(() => {
    if (!initialized) {
      initialized = true;
      gameServer.addPlayer(ws).then(id => {
        playerId = id;
      }).catch(err => console.error('Failed to add player on timeout:', err.message));
    }
  }, 1000);

  ws.on('message', async (data) => {
    try {
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

  ws.on('close', async () => {
    clearTimeout(initTimeout);
    if (playerId) {
      await gameServer.removePlayer(playerId);
    }
  });
});

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down...');
  await gameServer.saveSessions();
  await db.close();
  console.log('State saved. Exiting.');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Initialize DB, then start
(async () => {
  await initDB();
  await gameServer.init();
  gameServer.start();
  server.listen(PORT, () => {
    console.log(`$ROACH server running on http://localhost:${PORT}`);
  });
})();
