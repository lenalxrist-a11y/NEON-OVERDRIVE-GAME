const express  = require('express');
const http     = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path     = require('path');
const crypto   = require('crypto');
const fs       = require('fs');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
const PORT   = process.env.PORT || 3000;

// Serve static files
const publicDir = path.join(__dirname, 'public');
const staticDir = fs.existsSync(publicDir) ? publicDir : __dirname;
app.use(express.static(staticDir));

// AI tip endpoint
app.get('/api/tip', (req, res) => {
  const tips = [
    'Purple Chaos Chests make enemies fight each other!',
    'Mystery chests hide a random weapon — no peeking.',
    'Press R to reload before a fight, not during it.',
    'Squads mode gives 2.5x XP toward your rank.',
    'Shield does NOT regenerate. Save your Shield Cans.',
    'Sniper pierces multiple enemies. Line them up.',
    'Press 1 for Medkit, 2 for Shield mid-fight.',
    'Nuclear Blast Wave has 160px splash. Cluster enemies first.',
    'Shotgun fires 5 pellets — deadly up close.',
    'Teammates orbit you and target nearest enemies automatically.',
  ];
  res.json({ tip: tips[Math.floor(Math.random() * tips.length)] });
});

// ── CONSTANTS ───────────────────────────────────────────────────
const TICK_RATE = 20;
const MAX_ROOM  = 4;
const WORLD     = { W: 1280, H: 720 };

// ── STORAGE ─────────────────────────────────────────────────────
const rooms      = new Map(); // roomId  -> Room
const parties    = new Map(); // partyCode -> { leaderId, roomId, mode, withBots }
const clients    = new Map(); // ws -> { id, roomId, partyCode }

// ── PARTY CODE GEN ──────────────────────────────────────────────
function genPartyCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  // ensure unique
  if (parties.has(code)) return genPartyCode();
  return code;
}

// ── ROOM ────────────────────────────────────────────────────────
function createRoom(mode, withBots) {
  const id = crypto.randomBytes(4).toString('hex');
  const room = {
    id, mode, withBots,
    players:     new Map(),
    enemies:     [],
    bots:        [],
    bullets:     [],
    score:       0,
    winGoal:     { SOLO:30, DUOS:300, TRIOS:3000, SQUADS:30000 }[mode] || 30,
    spawnTimer:  0,
    botShootTimers: [],
    enemyId:     0,
    bulletId:    0,
    botId:       0,
    over:        false,
  };
  // Add bots if requested
  if (withBots) {
    const botCount = { SOLO:1, DUOS:1, TRIOS:2, SQUADS:3 }[mode] || 1;
    const botNames = ['GHOST_BOT','NEON_AI','CYBER_X','PHANTOM'];
    for (let i = 0; i < botCount; i++) {
      room.bots.push({
        id:   'bot_' + room.botId++,
        name: botNames[i] || 'BOT_' + i,
        x: 300 + Math.random() * 600,
        y: 200 + Math.random() * 300,
        r: 13, speed: 180,
        shield: 100, hull: 100,
        weaponColor: '#ff00ff',
        alive: true,
        shootCooldown: Math.random() * 1,
        score: 0,
      });
      room.botShootTimers.push(Math.random() * 1);
    }
  }
  rooms.set(id, room);
  return room;
}

function findPublicRoom(mode, withBots) {
  for (const [, room] of rooms) {
    if (room.mode === mode && room.withBots === withBots && !room.over &&
        !room.partyOnly && room.players.size < MAX_ROOM) return room;
  }
  const r = createRoom(mode, withBots);
  r.partyOnly = false;
  return r;
}

// ── PLAYER DEFAULTS ─────────────────────────────────────────────
function defaultPlayer(id, name, x, y, mode) {
  const isSquads = mode === 'SQUADS';
  return {
    id, name,
    x, y, r: 14, speed: 260,
    shield: 100, maxShield: 100,
    hull:   100, maxHull:   100,
    ammo: isSquads ? 999 : 30,
    weaponId:    isSquads ? 'nuclear' : 'plasma',
    weaponColor: isSquads ? '#adff2f' : '#00ffff',
    score: 0, alive: true,
    dx: 0, dy: 0,
    mouseX: x, mouseY: y,
    shooting: false,
    shootCooldown: 0,
  };
}

// ── ENEMY SPAWN ─────────────────────────────────────────────────
function spawnEnemy(room) {
  const side = Math.floor(Math.random() * 4);
  let x, y;
  if      (side === 0) { x = Math.random() * WORLD.W; y = -20; }
  else if (side === 1) { x = WORLD.W + 20;             y = Math.random() * WORLD.H; }
  else if (side === 2) { x = Math.random() * WORLD.W; y = WORLD.H + 20; }
  else                 { x = -20;                       y = Math.random() * WORLD.H; }
  room.enemies.push({ id: room.enemyId++, x, y, r: 12, speed: 110 + Math.random() * 60 });
}

// ── BROADCAST ───────────────────────────────────────────────────
function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of clients) {
    if (info.roomId === room.id && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function sendState(room) {
  if (room.over) return;
  // Combine real players + bots into one players list
  const allPlayers = [
    ...[...room.players.values()].map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, r: p.r,
      shield: p.shield, hull: p.hull, ammo: p.ammo,
      weaponColor: p.weaponColor, alive: p.alive, score: p.score, isBot: false,
    })),
    ...room.bots.map(b => ({
      id: b.id, name: b.name, x: b.x, y: b.y, r: b.r,
      shield: b.shield, hull: b.hull, ammo: 30,
      weaponColor: b.weaponColor, alive: b.alive, score: b.score, isBot: true,
    })),
  ];
  broadcast(room, {
    type:    'state',
    players: allPlayers,
    enemies: room.enemies.map(e => ({ id: e.id, x: e.x, y: e.y, r: e.r })),
    bullets: room.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, size: b.size, isNuclear: b.isNuclear })),
    score:   room.score,
    winGoal: room.winGoal,
  });
}

// ── TICK ─────────────────────────────────────────────────────────
function tickRoom(room, dt) {
  if (room.over) return;
  const alivePlayers = [...room.players.values()].filter(p => p.alive);
  const aliveBots    = room.bots.filter(b => b.alive);
  const allAlive     = [...alivePlayers, ...aliveBots];
  if (allAlive.length === 0) return;

  // Move real players
  alivePlayers.forEach(p => {
    p.shootCooldown = Math.max(0, p.shootCooldown - dt);
    let dx = p.dx, dy = p.dy;
    if (dx !== 0 && dy !== 0) { dx *= 0.7071; dy *= 0.7071; }
    p.x = Math.max(p.r, Math.min(WORLD.W - p.r, p.x + dx * p.speed * dt));
    p.y = Math.max(p.r, Math.min(WORLD.H - p.r, p.y + dy * p.speed * dt));
    if (p.shooting && p.shootCooldown <= 0 && p.ammo > 0) {
      p.ammo--; p.shootCooldown = 0.15;
      const angle = Math.atan2(p.mouseY - p.y, p.mouseX - p.x);
      room.bullets.push({ id: room.bulletId++, x: p.x, y: p.y,
        vx: Math.cos(angle) * 750, vy: Math.sin(angle) * 750,
        size: 4, isNuclear: p.weaponId === 'nuclear', ownerId: p.id, dmg: 1 });
    }
  });

  // Move bots — find nearest enemy and shoot at it
  aliveBots.forEach(bot => {
    bot.shootCooldown = Math.max(0, bot.shootCooldown - dt);
    if (room.enemies.length > 0) {
      let closest = room.enemies[0], minD = Infinity;
      room.enemies.forEach(e => {
        const d = Math.hypot(e.x - bot.x, e.y - bot.y);
        if (d < minD) { minD = d; closest = e; }
      });
      // Move toward enemy
      const ang = Math.atan2(closest.y - bot.y, closest.x - bot.x);
      bot.x = Math.max(bot.r, Math.min(WORLD.W - bot.r, bot.x + Math.cos(ang) * bot.speed * dt));
      bot.y = Math.max(bot.r, Math.min(WORLD.H - bot.r, bot.y + Math.sin(ang) * bot.speed * dt));
      // Shoot
      if (bot.shootCooldown <= 0 && minD < 350) {
        bot.shootCooldown = 0.4 + Math.random() * 0.3;
        room.bullets.push({ id: room.bulletId++, x: bot.x, y: bot.y,
          vx: Math.cos(ang) * 700, vy: Math.sin(ang) * 700,
          size: 4, isNuclear: false, ownerId: bot.id, dmg: 1 });
      }
    } else {
      // Patrol
      bot.x = Math.max(bot.r, Math.min(WORLD.W - bot.r, bot.x + (Math.random() - 0.5) * 40 * dt));
      bot.y = Math.max(bot.r, Math.min(WORLD.H - bot.r, bot.y + (Math.random() - 0.5) * 40 * dt));
    }
  });

  // Spawn enemies
  room.spawnTimer += dt;
  const interval = room.mode === 'SQUADS' ? 0.04 : 0.4;
  if (room.spawnTimer >= interval) {
    room.spawnTimer = 0;
    const count = room.mode === 'SQUADS' ? 4 : 1;
    for (let i = 0; i < count; i++) spawnEnemy(room);
  }

  // Move bullets
  room.bullets.forEach(b => { b.x += b.vx * dt; b.y += b.vy * dt; });
  room.bullets = room.bullets.filter(b =>
    b.x > -50 && b.x < WORLD.W+50 && b.y > -50 && b.y < WORLD.H+50);

  // Collisions
  const deadEnemies = new Set();
  const deadBullets = new Set();

  room.enemies.forEach((e, ei) => {
    if (deadEnemies.has(ei)) return;
    // Move toward nearest target
    let target = allAlive[0], minD = Infinity;
    allAlive.forEach(t => {
      const d = Math.hypot(t.x - e.x, t.y - e.y);
      if (d < minD) { minD = d; target = t; }
    });
    if (!target) return;
    const ang = Math.atan2(target.y - e.y, target.x - e.x);
    e.x += Math.cos(ang) * e.speed * dt;
    e.y += Math.sin(ang) * e.speed * dt;

    // Hit real player
    alivePlayers.forEach(p => {
      if (Math.hypot(p.x - e.x, p.y - e.y) < p.r + e.r) {
        deadEnemies.add(ei);
        if (p.shield > 0) p.shield = Math.max(0, p.shield - 15);
        else               p.hull   = Math.max(0, p.hull   - 15);
        if (p.hull <= 0) { p.alive = false; broadcast(room, { type:'playerDied', id:p.id }); }
      }
    });

    // Hit bot
    aliveBots.forEach(bot => {
      if (!deadEnemies.has(ei) && Math.hypot(bot.x - e.x, bot.y - e.y) < bot.r + e.r) {
        deadEnemies.add(ei);
        bot.hull = Math.max(0, bot.hull - 20);
        if (bot.hull <= 0) bot.alive = false;
      }
    });

    // Hit by bullet
    room.bullets.forEach((b, bi) => {
      if (deadBullets.has(bi) || deadEnemies.has(ei)) return;
      if (Math.hypot(b.x - e.x, b.y - e.y) < e.r + b.size) {
        deadBullets.add(bi);
        if (b.isNuclear) {
          room.enemies.forEach((ne, ni) => {
            if (!deadEnemies.has(ni) && Math.hypot(ne.x - e.x, ne.y - e.y) < 160) {
              deadEnemies.add(ni); room.score++;
            }
          });
        } else { deadEnemies.add(ei); room.score++; }
        // Credit shooter
        const shooter = room.players.get(b.ownerId) || room.bots.find(bt => bt.id === b.ownerId);
        if (shooter) shooter.score++;
        if (room.score >= room.winGoal) {
          room.over = true;
          broadcast(room, { type:'victory', score:room.score });
        }
      }
    });
  });

  [...deadBullets].sort((a,b)=>b-a).forEach(i => room.bullets.splice(i,1));
  [...deadEnemies].sort((a,b)=>b-a).forEach(i => room.enemies.splice(i,1));

  // Check all real players dead
  if (alivePlayers.length > 0 && alivePlayers.every(p => !p.alive)) {
    room.over = true;
    broadcast(room, { type:'gameOver', score:room.score });
  }
}

// ── GAME LOOP ────────────────────────────────────────────────────
setInterval(() => {
  const dt = 1 / TICK_RATE;
  for (const [, room] of rooms) {
    if (!room.over && room.players.size > 0) { tickRoom(room, dt); sendState(room); }
  }
  for (const [id, room] of rooms) {
    if (room.over && room.players.size === 0) rooms.delete(id);
  }
}, 1000 / TICK_RATE);

// ── WEBSOCKET ────────────────────────────────────────────────────
wss.on('connection', ws => {
  const clientId = crypto.randomUUID();
  clients.set(ws, { id: clientId, roomId: null, partyCode: null });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const info = clients.get(ws);

    // ── CREATE PARTY ──────────────────────────────────────────
    if (msg.type === 'createParty') {
      const code     = genPartyCode();
      const mode     = msg.mode     || 'SOLO';
      const withBots = !!msg.withBots;
      const room     = createRoom(mode, withBots);
      room.partyOnly = true;
      parties.set(code, { leaderId: clientId, roomId: room.id, mode, withBots });
      info.partyCode = code;
      ws.send(JSON.stringify({ type:'partyCreated', code, mode, withBots }));
      console.log(`[PARTY] Created ${code} — mode:${mode} bots:${withBots}`);
    }

    // ── JOIN PARTY ────────────────────────────────────────────
    if (msg.type === 'joinParty') {
      const code  = (msg.code || '').toUpperCase().trim();
      const party = parties.get(code);
      if (!party) { ws.send(JSON.stringify({ type:'partyError', msg:'Invalid code. Check and try again.' })); return; }
      const room = rooms.get(party.roomId);
      if (!room || room.over) { ws.send(JSON.stringify({ type:'partyError', msg:'That party has already started or ended.' })); return; }
      if (room.players.size >= MAX_ROOM) { ws.send(JSON.stringify({ type:'partyError', msg:'Party is full (max 4 players).' })); return; }
      info.partyCode = code;
      ws.send(JSON.stringify({ type:'partyJoined', code, mode:party.mode, withBots:party.withBots }));
      console.log(`[PARTY] ${clientId} joined party ${code}`);
    }

    // ── JOIN GAME ─────────────────────────────────────────────
    if (msg.type === 'join') {
      const mode     = msg.mode     || 'SOLO';
      const withBots = !!msg.withBots;
      const name     = (msg.name || 'Player').slice(0, 20);
      let room;
      if (info.partyCode) {
        const party = parties.get(info.partyCode);
        room = party ? rooms.get(party.roomId) : null;
        if (!room) { room = findPublicRoom(mode, withBots); }
      } else {
        room = findPublicRoom(mode, withBots);
      }
      const startX = 200 + Math.random() * (WORLD.W - 400);
      const startY = 200 + Math.random() * (WORLD.H - 400);
      const player = defaultPlayer(clientId, name, startX, startY, mode);
      room.players.set(clientId, player);
      info.roomId = room.id;
      ws.send(JSON.stringify({ type:'joined', playerId:clientId, roomId:room.id, mode, winGoal:room.winGoal, worldW:WORLD.W, worldH:WORLD.H, withBots }));
      broadcast(room, { type:'playerJoined', id:clientId, name });
      // Tell everyone how many players are in the party
      broadcast(room, { type:'partyUpdate', count: room.players.size, max: MAX_ROOM });
      console.log(`[+] ${name} joined room ${room.id} (${mode} bots:${withBots}) — ${room.players.size} players`);
    }

    // ── INPUT ─────────────────────────────────────────────────
    if (msg.type === 'input') {
      const player = info.roomId ? rooms.get(info.roomId)?.players.get(info.id) : null;
      const p = rooms.get(info.roomId)?.players.get(clientId);
      if (!p?.alive) return;
      p.dx       = Math.max(-1, Math.min(1, msg.dx       || 0));
      p.dy       = Math.max(-1, Math.min(1, msg.dy       || 0));
      p.mouseX   = msg.mouseX ?? p.mouseX;
      p.mouseY   = msg.mouseY ?? p.mouseY;
      p.shooting = !!msg.shooting;
      if (msg.weaponId)    p.weaponId    = msg.weaponId;
      if (msg.weaponColor) p.weaponColor = msg.weaponColor;
      if (msg.reload)      p.ammo        = 30;
    }

    // ── CHAT ─────────────────────────────────────────────────
    if (msg.type === 'chat') {
      if (!info.roomId) return;
      const room = rooms.get(info.roomId); if (!room) return;
      const p = room.players.get(clientId);
      broadcast(room, { type:'chat', name: p?.name || '?', text: (msg.text||'').slice(0,120) });
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info?.roomId) {
      const room = rooms.get(info.roomId);
      if (room) {
        room.players.delete(clientId);
        broadcast(room, { type:'playerLeft', id:clientId });
        broadcast(room, { type:'partyUpdate', count:room.players.size, max:MAX_ROOM });
        console.log(`[-] Player left room ${info.roomId} — ${room.players.size} remaining`);
      }
    }
    // Clean up party if leader leaves
    if (info?.partyCode) {
      const party = parties.get(info.partyCode);
      if (party?.leaderId === clientId) parties.delete(info.partyCode);
    }
    clients.delete(ws);
  });
});

server.listen(PORT, () => console.log(`Neon Overdrive running on port ${PORT}`));
