const express = require('express');
const http    = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

// Serve the game client
app.use(express.static(path.join(__dirname, 'public')));

// ── GAME STATE ──────────────────────────────────────────────────
const TICK_RATE    = 20;   // server ticks per second
const MAX_ROOM     = 4;    // max players per room

const rooms   = new Map(); // roomId -> Room
const clients = new Map(); // ws -> { id, roomId, player }

// ── ROOM ────────────────────────────────────────────────────────
function createRoom(mode) {
  const id = crypto.randomBytes(4).toString('hex');
  const room = {
    id,
    mode,
    players:  new Map(),   // playerId -> playerState
    enemies:  [],
    bullets:  [],
    score:    0,
    winGoal:  { SOLO:30, DUOS:300, TRIOS:3000, SQUADS:30000 }[mode] || 30,
    spawnTimer: 0,
    enemyId:  0,
    bulletId: 0,
    started:  false,
    over:     false,
    tick:     0,
  };
  rooms.set(id, room);
  return room;
}

function findOrCreateRoom(mode) {
  for (const [, room] of rooms) {
    if (room.mode === mode && !room.over && room.players.size < MAX_ROOM) return room;
  }
  return createRoom(mode);
}

// ── PLAYER DEFAULTS ─────────────────────────────────────────────
function defaultPlayer(id, name, x, y) {
  return {
    id, name,
    x, y, r: 14,
    speed: 260,
    shield: 100, maxShield: 100,
    hull:   100, maxHull:   100,
    ammo: 30,
    weaponId: 'plasma',
    weaponColor: '#00ffff',
    score: 0,
    alive: true,
    // input state (sent from client each tick)
    dx: 0, dy: 0,
    mouseX: x, mouseY: y,
    shooting: false,
    shootCooldown: 0,
  };
}

// ── ENEMY SPAWN ─────────────────────────────────────────────────
function spawnEnemy(room, W, H) {
  const side = Math.floor(Math.random() * 4);
  let x, y;
  if      (side === 0) { x = Math.random() * W; y = -20; }
  else if (side === 1) { x = W + 20;             y = Math.random() * H; }
  else if (side === 2) { x = Math.random() * W; y = H + 20; }
  else                 { x = -20;                y = Math.random() * H; }
  room.enemies.push({ id: room.enemyId++, x, y, r: 12, speed: 110 + Math.random() * 60, hp: 1 });
}

// ── SERVER TICK ─────────────────────────────────────────────────
const WORLD = { W: 1280, H: 720 };

function tickRoom(room, dt) {
  if (room.over) return;
  const alivePlayers = [...room.players.values()].filter(p => p.alive);
  if (alivePlayers.length === 0) return;

  // --- Move players ---
  alivePlayers.forEach(p => {
    p.shootCooldown = Math.max(0, p.shootCooldown - dt);
    let dx = p.dx, dy = p.dy;
    if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }
    p.x = Math.max(p.r, Math.min(WORLD.W - p.r, p.x + dx * p.speed * dt));
    p.y = Math.max(p.r, Math.min(WORLD.H - p.r, p.y + dy * p.speed * dt));

    // Auto-shoot
    if (p.shooting && p.shootCooldown <= 0 && p.ammo > 0) {
      p.ammo--;
      p.shootCooldown = 0.15;
      const angle = Math.atan2(p.mouseY - p.y, p.mouseX - p.x);
      room.bullets.push({
        id: room.bulletId++,
        x: p.x, y: p.y,
        vx: Math.cos(angle) * 750,
        vy: Math.sin(angle) * 750,
        size: 4, isNuclear: p.weaponId === 'nuclear',
        ownerId: p.id, dmg: 1,
      });
    }
    // Auto-reload
    if (p.ammo <= 0) p.ammo = 0;
  });

  // --- Spawn enemies ---
  room.spawnTimer += dt;
  const interval = room.mode === 'SQUADS' ? 0.04 : 0.4;
  if (room.spawnTimer >= interval) {
    room.spawnTimer = 0;
    const count = room.mode === 'SQUADS' ? 4 : 1;
    for (let i = 0; i < count; i++) spawnEnemy(room, WORLD.W, WORLD.H);
  }

  // --- Move bullets ---
  room.bullets.forEach(b => { b.x += b.vx * dt; b.y += b.vy * dt; });
  room.bullets = room.bullets.filter(b =>
    b.x > -50 && b.x < WORLD.W + 50 && b.y > -50 && b.y < WORLD.H + 50
  );

  // --- Move enemies, check collisions ---
  const deadEnemies = new Set();
  const deadBullets = new Set();

  room.enemies.forEach((e, ei) => {
    if (deadEnemies.has(ei)) return;

    // Move toward nearest alive player
    let target = alivePlayers[0];
    let minD = Infinity;
    alivePlayers.forEach(p => {
      const d = Math.hypot(p.x - e.x, p.y - e.y);
      if (d < minD) { minD = d; target = p; }
    });
    if (!target) return;
    const ang = Math.atan2(target.y - e.y, target.x - e.x);
    e.x += Math.cos(ang) * e.speed * dt;
    e.y += Math.sin(ang) * e.speed * dt;

    // Hit player
    alivePlayers.forEach(p => {
      if (Math.hypot(p.x - e.x, p.y - e.y) < p.r + e.r) {
        deadEnemies.add(ei);
        if (p.shield > 0) p.shield = Math.max(0, p.shield - 15);
        else               p.hull   = Math.max(0, p.hull   - 15);
        if (p.hull <= 0) {
          p.alive = false;
          broadcast(room, { type: 'playerDied', id: p.id });
        }
      }
    });

    // Hit by bullet
    room.bullets.forEach((b, bi) => {
      if (deadBullets.has(bi) || deadEnemies.has(ei)) return;
      if (Math.hypot(b.x - e.x, b.y - e.y) < e.r + b.size) {
        deadBullets.add(bi);
        if (b.isNuclear) {
          // splash
          room.enemies.forEach((ne, ni) => {
            if (!deadEnemies.has(ni) && Math.hypot(ne.x - e.x, ne.y - e.y) < 160) {
              deadEnemies.add(ni);
              room.score++;
            }
          });
        } else {
          deadEnemies.add(ei);
          room.score++;
        }
        // credit the shooter
        const shooter = room.players.get(b.ownerId);
        if (shooter) shooter.score++;

        if (room.score >= room.winGoal) {
          room.over = true;
          broadcast(room, { type: 'victory', score: room.score });
        }
      }
    });
  });

  [...deadBullets].sort((a, b) => b - a).forEach(i => room.bullets.splice(i, 1));
  [...deadEnemies].sort((a, b) => b - a).forEach(i => room.enemies.splice(i, 1));

  // Check if all players dead
  if (alivePlayers.length > 0 && alivePlayers.every(p => !p.alive)) {
    room.over = true;
    broadcast(room, { type: 'gameOver', score: room.score });
  }
}

// ── BROADCAST ───────────────────────────────────────────────────
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of clients) {
    if (info.roomId === room.id && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

function sendState(room) {
  if (room.over) return;
  broadcast(room, {
    type:    'state',
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, r: p.r,
      shield: p.shield, hull: p.hull, ammo: p.ammo,
      weaponColor: p.weaponColor, alive: p.alive, score: p.score,
    })),
    enemies: room.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, r: e.r })),
    bullets: room.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, size: b.size, isNuclear: b.isNuclear })),
    score:   room.score,
    winGoal: room.winGoal,
  });
}

// ── GAME LOOP ───────────────────────────────────────────────────
setInterval(() => {
  const dt = 1 / TICK_RATE;
  for (const [, room] of rooms) {
    if (!room.over && room.players.size > 0) {
      tickRoom(room, dt);
      sendState(room);
    }
  }
  // Cleanup dead rooms older than 30s
  for (const [id, room] of rooms) {
    if (room.over && room.players.size === 0) rooms.delete(id);
  }
}, 1000 / TICK_RATE);

// ── WEBSOCKET HANDLER ────────────────────────────────────────────
wss.on('connection', (ws) => {
  const clientId = crypto.randomUUID();
  clients.set(ws, { id: clientId, roomId: null, player: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const info = clients.get(ws);

    if (msg.type === 'join') {
      const mode = msg.mode || 'SOLO';
      const name = (msg.name || 'Player').slice(0, 20);
      const room = findOrCreateRoom(mode);

      const startX = 200 + Math.random() * (WORLD.W - 400);
      const startY = 200 + Math.random() * (WORLD.H - 400);
      const player = defaultPlayer(clientId, name, startX, startY);
      if (mode === 'SQUADS') { player.weaponId = 'nuclear'; player.weaponColor = '#adff2f'; player.ammo = 999; }

      room.players.set(clientId, player);
      info.roomId = room.id;
      info.player = player;

      ws.send(JSON.stringify({
        type: 'joined',
        playerId: clientId,
        roomId:   room.id,
        mode,
        winGoal:  room.winGoal,
        worldW:   WORLD.W,
        worldH:   WORLD.H,
      }));

      broadcast(room, { type: 'playerJoined', id: clientId, name });
      console.log(`[+] ${name} joined room ${room.id} (${mode}) — ${room.players.size} players`);
    }

    if (msg.type === 'input') {
      const info2 = clients.get(ws);
      if (!info2?.player) return;
      const p = info2.player;
      if (!p.alive) return;
      p.dx       = Math.max(-1, Math.min(1, msg.dx       || 0));
      p.dy       = Math.max(-1, Math.min(1, msg.dy       || 0));
      p.mouseX   = msg.mouseX ?? p.mouseX;
      p.mouseY   = msg.mouseY ?? p.mouseY;
      p.shooting = !!msg.shooting;
      // client-side weapon/reload sync
      if (msg.weaponId)    p.weaponId    = msg.weaponId;
      if (msg.weaponColor) p.weaponColor = msg.weaponColor;
      if (msg.reload)      p.ammo        = 30;
    }

    if (msg.type === 'chat') {
      const info3 = clients.get(ws);
      if (!info3?.roomId) return;
      const room = rooms.get(info3.roomId);
      if (!room) return;
      const player = info3.player;
      broadcast(room, { type: 'chat', name: player?.name || '?', text: (msg.text || '').slice(0, 120) });
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info?.roomId) {
      const room = rooms.get(info.roomId);
      if (room) {
        room.players.delete(info.id);
        broadcast(room, { type: 'playerLeft', id: info.id });
        console.log(`[-] Player left room ${info.roomId} — ${room.players.size} remaining`);
      }
    }
    clients.delete(ws);
  });
});


// AI tip endpoint
app.get("/api/tip", async (req, res) => {
  const tips = [
    "Purple Chaos Chests make enemies fight each other!",
    "Mystery chests hide a random weapon — no peeking.",
    "Press R to reload before a fight, not during it.",
    "Squads mode gives 2.5x XP toward your rank.",
    "Shield does NOT regenerate. Save your Shield Cans.",
    "Sniper pierces multiple enemies. Line them up.",
    "Press 1 for Medkit, 2 for Shield mid-fight.",
    "Nuclear Blast Wave has 160px splash. Use it on clusters.",
    "Shotgun fires 5 pellets — deadly up close.",
    "Teammates orbit you and target nearest enemies automatically.",
  ];
  res.json({ tip: tips[Math.floor(Math.random() * tips.length)] });
});

server.listen(PORT, () => console.log(`Neon Overdrive server running on port ${PORT}`));
