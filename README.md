# 🎮 Neon Overdrive — Multiplayer

Real-time multiplayer top-down shooter. Deploy to Railway in ~5 minutes.

---

## 🚀 Deploy to Railway (free, public URL)

### Step 1 — Create a GitHub repo
1. Go to https://github.com/new
2. Name it `neon-overdrive`
3. Leave it empty (no README), click **Create repository**

### Step 2 — Push this project
Open a terminal in this folder and run:

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/neon-overdrive.git
git push -u origin main
```
(replace YOUR_USERNAME with your GitHub username)

### Step 3 — Deploy on Railway
1. Go to https://railway.app and sign in with GitHub
2. Click **New Project** → **Deploy from GitHub repo**
3. Select `neon-overdrive`
4. Railway auto-detects Node.js and deploys!
5. Click **Settings → Networking → Generate Domain**
6. You'll get a URL like `neon-overdrive-production.up.railway.app`

### Step 4 — Share the URL
Send that URL to anyone. They open it in a browser and play together in real time!

---

## 🎮 Controls
- **WASD / Arrow keys** — Move
- **Click / Hold** — Shoot  
- **R** — Reload
- **T** — Open chat
- **Enter** — Send chat
- **Escape** — Close chat

---

## 📁 File structure
```
neon-overdrive-multiplayer/
├── server.js          ← WebSocket + Express server (runs on Railway)
├── package.json       ← Node.js dependencies
├── railway.json       ← Railway deployment config
└── public/
    └── index.html     ← Game client (served to players)
```

---

## 🔧 How it works
- Players connect via WebSocket
- Server runs the game simulation at 20 ticks/second
- Client sends input (WASD + mouse) to server every 50ms
- Server sends full game state back to all players in the room
- Up to 4 players per room, rooms auto-created per mode
