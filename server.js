const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

const ROACH_WIDTH = 35;
const ROACH_HEIGHT = 35;
const BOOT_WIDTH = 100;
const BOOT_HEIGHT = 110;
const STOMP_COOLDOWN = 200;
const RESPAWN_DELAY_MS = 3000;

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const requestUrl = req.url.split('?')[0];
  const filePath = requestUrl === '/' ? '/roach-prototype.html' : requestUrl;
  const resolvedPath = path.join(ROOT_DIR, decodeURIComponent(filePath));

  if (!resolvedPath.startsWith(ROOT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolvedPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const ext = path.extname(resolvedPath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
let nextPlayerId = 1;
const players = new Map();
const socketToPlayer = new Map();

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

function broadcastState() {
  broadcast({
    type: 'state',
    players: Array.from(players.values()).map((player) => ({
      id: player.id,
      x: player.x,
      y: player.y,
      vx: player.vx,
      vy: player.vy,
      balance: player.balance,
      hp: player.hp,
      room: player.room,
      isDead: player.isDead,
    })),
  });
}

function scheduleRespawn(player) {
  if (player.respawnTimeout) return;
  player.respawnTimeout = setTimeout(() => {
    player.isDead = false;
    player.hp = 3;
    player.x = Math.random() * 540 + 30;
    player.y = Math.random() * 340 + 30;
    player.respawnTimeout = null;
    broadcastState();
  }, RESPAWN_DELAY_MS);
}

function handleStomp(attackerId, x, y) {
  const attacker = players.get(attackerId);
  if (!attacker || attacker.isDead) return;
  const now = Date.now();
  if (now - attacker.lastStomp < STOMP_COOLDOWN) return;
  attacker.lastStomp = now;

  const bootLeft = x - BOOT_WIDTH / 2;
  const bootRight = x + BOOT_WIDTH / 2;
  const bootTop = y - BOOT_HEIGHT * 0.8;
  const bootBottom = y + BOOT_HEIGHT * 0.2;

  for (const target of players.values()) {
    if (target.id === attackerId || target.isDead) continue;
    if (target.room !== attacker.room) continue;

    const centerX = target.x + ROACH_WIDTH / 2;
    const centerY = target.y + ROACH_HEIGHT / 2;
    const inX = centerX >= bootLeft && centerX <= bootRight;
    const inY = centerY >= bootTop && centerY <= bootBottom;

    if (!inX || !inY) continue;

    target.hp -= 1;
    if (target.hp <= 0) {
      const reward = target.balance * 0.9;
      attacker.balance += reward;
      target.balance -= reward;
      target.isDead = true;
      target.hp = 0;
      scheduleRespawn(target);
    }
  }

  broadcastState();
}

wss.on('connection', (ws) => {
  const playerId = `player-${nextPlayerId++}`;
  socketToPlayer.set(ws, playerId);
  players.set(playerId, {
    id: playerId,
    x: 50,
    y: 50,
    vx: 0,
    vy: 0,
    balance: 0,
    hp: 3,
    room: '0,0',
    isDead: false,
    lastStomp: 0,
    respawnTimeout: null,
  });

  ws.send(JSON.stringify({ type: 'welcome', id: playerId }));
  broadcastState();

  ws.on('message', (data) => {
    let payload = null;
    try {
      payload = JSON.parse(data.toString());
    } catch (err) {
      return;
    }

    const currentPlayerId = socketToPlayer.get(ws);
    const player = players.get(currentPlayerId);
    if (!player) return;

    if (payload.type === 'state_update' && payload.state) {
      const nextState = payload.state;
      player.x = nextState.x;
      player.y = nextState.y;
      player.vx = nextState.vx;
      player.vy = nextState.vy;
      player.room = nextState.room;

      if (!player.isDead) {
        player.balance = nextState.balance;
        player.hp = nextState.hp;
        player.isDead = Boolean(nextState.isDead);
      }

      if (player.isDead && nextState.isDead) {
        player.balance = nextState.balance;
      }

      broadcastState();
    }

    if (payload.type === 'stomp') {
      handleStomp(currentPlayerId, payload.x, payload.y);
    }
  });

  ws.on('close', () => {
    const currentPlayerId = socketToPlayer.get(ws);
    socketToPlayer.delete(ws);
    players.delete(currentPlayerId);
    broadcast({ type: 'player_left', id: currentPlayerId });
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log(`$ROACH server running at http://localhost:${PORT}`);
});
