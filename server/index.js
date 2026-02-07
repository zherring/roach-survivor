import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { GameServer } from './game-server.js';

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(import.meta.dirname, '..');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const server = http.createServer((req, res) => {
  let filePath;
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(ROOT, 'client', 'index.html');
  } else if (req.url === '/shared/constants.js') {
    filePath = path.join(ROOT, 'shared', 'constants.js');
  } else {
    // Serve from client/
    filePath = path.join(ROOT, 'client', req.url);
  }

  // Prevent directory traversal — must be under client/ (not just project root)
  const CLIENT_DIR = path.join(ROOT, 'client');
  if (!filePath.startsWith(CLIENT_DIR + path.sep) && filePath !== path.join(ROOT, 'shared', 'constants.js')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const gameServer = new GameServer();

wss.on('connection', (ws) => {
  const playerId = gameServer.addPlayer(ws);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      gameServer.handleMessage(playerId, msg);
    } catch (e) {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    gameServer.removePlayer(playerId);
  });
});

gameServer.start();

server.listen(PORT, () => {
  console.log(`$ROACH server running on http://localhost:${PORT}`);
});
