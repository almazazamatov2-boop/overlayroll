import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import {
  pool, initDB, getStreamer, getStreamerByTwitchId,
  getAllStreamersWithTokens, upsertStreamer, updateTokens, updateSettings,
  isWhitelisted, getWhitelist, addToWhitelist, removeFromWhitelist
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APP_PORT  = Number(process.env.APP_PORT || 3000);
const CLIENT_ID     = process.env.TWITCH_CLIENT_ID;
const CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const BASE_URL  = (process.env.BASE_URL || `http://localhost:${APP_PORT}`).replace(/\/$/, '');

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET not set in .env');
  process.exit(1);
}

// ─── Directories ─────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/assets', express.static(UPLOADS_DIR));

// ─── Multer ───────────────────────────────────────────────────────────────────
const ALLOWED_ASSETS = ['panel_bg', 'reward_img', 's_in', 's_roll', 's_win', 's_lose', 's_out'];

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOADS_DIR, req.params.streamerId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    // Remove all old files with that asset name first (different ext)
    const dir = path.join(UPLOADS_DIR, req.params.streamerId);
    const assetName = req.params.assetName;
    try {
      fs.readdirSync(dir)
        .filter(f => f.startsWith(assetName + '.'))
        .forEach(f => fs.unlinkSync(path.join(dir, f)));
    } catch {}
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, assetName + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─── WebSocket rooms ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map(); // streamerId -> Set<WebSocket>

function broadcast(streamerId, payload) {
  const clients = rooms.get(streamerId);
  if (!clients) return;
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) ws.send(data);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000);

async function twitchFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Twitch ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function refreshToken(streamer) {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: streamer.refresh_token,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET
  });
  const data = await twitchFetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });
  const tokens = {
    access_token:  data.access_token,
    refresh_token: data.refresh_token ?? streamer.refresh_token,
    expires_at:    nowSec() + data.expires_in
  };
  await updateTokens(streamer.id, tokens);
  return tokens.access_token;
}

async function getValidToken(streamer) {
  if (streamer.access_token && streamer.expires_at > nowSec() + 30) return streamer.access_token;
  if (streamer.refresh_token) return refreshToken(streamer);
  return null;
}

function parsePickNumber(text, min, max) {
  const m = (text || '').trim().match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Find an uploaded asset file, return its URL or null
function getAssetUrl(streamerId, assetName) {
  const dir = path.join(UPLOADS_DIR, streamerId);
  if (!fs.existsSync(dir)) return null;
  const exts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp3', '.ogg', '.wav'];
  for (const ext of exts) {
    if (fs.existsSync(path.join(dir, assetName + ext))) {
      return `${BASE_URL}/assets/${streamerId}/${assetName}${ext}`;
    }
  }
  return null;
}

// ─── EventSub ─────────────────────────────────────────────────────────────────
const eventsubConnections = new Map(); // streamerId -> WebSocket

async function startEventSub(streamerId) {
  const existing = eventsubConnections.get(streamerId);
  if (existing && (existing.readyState === 0 || existing.readyState === 1)) return;

  const streamer = await getStreamer(streamerId);
  if (!streamer) return;
  const token = await getValidToken(streamer);
  if (!token) { console.log(`⚠️ No valid token for ${streamer.twitch_login}`); return; }

  const { WebSocket } = await import('ws');
  const ws = new WebSocket('wss://eventsub.wss.twitch.tv/ws');
  eventsubConnections.set(streamerId, ws);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const { metadata, payload } = msg;

    if (metadata?.message_type === 'session_welcome') {
      const sessionId = payload.session.id;
      try {
        const freshStreamer = await getStreamer(streamerId);
        const freshToken = await getValidToken(freshStreamer);

        const userData = await twitchFetch('https://api.twitch.tv/helix/users', {
          headers: { 'Authorization': `Bearer ${freshToken}`, 'Client-Id': CLIENT_ID }
        });
        const broadcasterId = userData.data[0].id;

        await twitchFetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${freshToken}`,
            'Client-Id': CLIENT_ID,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'channel.channel_points_custom_reward_redemption.add',
            version: '1',
            condition: { broadcaster_user_id: broadcasterId },
            transport: { method: 'websocket', session_id: sessionId }
          })
        });
        console.log(`✅ EventSub active: ${freshStreamer.twitch_login}`);
      } catch (e) {
        console.error(`❌ EventSub subscribe error for ${streamerId}:`, e.message);
      }
    }

    if (metadata?.message_type === 'notification') {
      if (metadata.subscription_type !== 'channel.channel_points_custom_reward_redemption.add') return;
      try {
        const freshStreamer = await getStreamer(streamerId);
        const ev = payload.event;
        if (ev.reward?.title !== freshStreamer.reward_title) return;

        const pick   = parsePickNumber(ev.user_input, freshStreamer.min_num, freshStreamer.max_num);
        const rolled = randInt(freshStreamer.min_num, freshStreamer.max_num);
        const result = (pick !== null && pick === rolled) ? 'win' : 'lose';

        broadcast(streamerId, {
          type: 'fate_random',
          user: ev.user_name,
          pick, rolled, result,
          reward: ev.reward.title
        });

        console.log(`🎲 [${freshStreamer.twitch_login}] ${ev.user_name} pick=${pick} rolled=${rolled} => ${result}`);
      } catch (e) {
        console.error('❌ Notification handling error:', e.message);
      }
    }

    if (metadata?.message_type === 'session_keepalive') { /* noop */ }
  });

  ws.on('close', () => {
    console.log(`⚠️ EventSub closed for ${streamerId}, reconnecting in 3s...`);
    eventsubConnections.delete(streamerId);
    setTimeout(() => startEventSub(streamerId).catch(console.error), 3000);
  });

  ws.on('error', (e) => {
    console.log(`⚠️ EventSub error for ${streamerId}:`, e.message);
  });
}

// ─── OAuth state ──────────────────────────────────────────────────────────────
const oauthStates = new Map(); // state -> { tempId }

// ─── Routes ───────────────────────────────────────────────────────────────────

// Home
app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Fate Overlay</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box} body{font-family:Inter,sans-serif;background:#0e0e10;color:#efeff1;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
  .card{background:#18181b;border-radius:16px;padding:40px;max-width:480px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.5)}
  h1{color:#9146ff;font-size:2em;margin:0 0 12px} p{color:#adadb8;line-height:1.6}
  .btn{display:inline-block;padding:14px 28px;background:#9146ff;color:white;text-decoration:none;border-radius:10px;font-weight:700;font-size:16px;margin-top:20px;transition:background 0.2s}
  .btn:hover{background:#a970ff}
  .dice{font-size:3em;margin-bottom:16px}
</style></head>
<body><div class="card">
  <div class="dice">🎲</div>
  <h1>Fate Overlay</h1>
  <a href="/auth" class="btn">Войти через Twitch</a>
</div></body></html>`);
});

// Auth start
app.get('/auth', (req, res) => {
  const state  = crypto.randomBytes(16).toString('hex');
  const tempId = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { tempId });
  setTimeout(() => oauthStates.delete(state), 5 * 60 * 1000);

  const scope    = encodeURIComponent('channel:read:redemptions');
  const redirect = encodeURIComponent(`${BASE_URL}/callback`);
  res.redirect(
    `https://id.twitch.tv/oauth2/authorize?response_type=code` +
    `&client_id=${CLIENT_ID}&redirect_uri=${redirect}&scope=${scope}&state=${state}`
  );
});

// OAuth callback
app.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || !oauthStates.has(state)) return res.status(400).send('Invalid or expired state. <a href="/auth">Try again</a>');

    const { tempId } = oauthStates.get(state);
    oauthStates.delete(state);

    const params = new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      code, grant_type: 'authorization_code',
      redirect_uri: `${BASE_URL}/callback`
    });
    const tokenData = await twitchFetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: params });

    const userData = await twitchFetch('https://api.twitch.tv/helix/users', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'Client-Id': CLIENT_ID }
    });
    const user = userData.data[0];

    // ── Whitelist check ──
    const allowed = await isWhitelisted(user.login);
    if (!allowed) {
      return res.type('html').send(`<!DOCTYPE html>
<html lang='ru'><head><meta charset='utf-8'><title>Доступ закрыт</title>
<style>body{font-family:Inter,sans-serif;background:#0e0e10;color:#efeff1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#18181b;border-radius:16px;padding:40px;max-width:440px;text-align:center}
h1{color:#ff4d4d;margin:0 0 12px}p{color:#adadb8;line-height:1.6}
.btn{display:inline-block;margin-top:20px;padding:12px 24px;background:#3a3a3d;color:#efeff1;text-decoration:none;border-radius:8px;font-weight:700}</style></head>
<body><div class='card'>
  <div style='font-size:3em'>🚫</div>
  <h1>Доступ закрыт</h1>
  <p>Свяжитесь со мной @paracetomolhaze для получения доступа.</p>
  <a href='/' class='btn'>← Назад</a>
</div></body></html>`);
    }

    const existing   = await getStreamerByTwitchId(user.id);
    const streamerId = existing?.id || tempId;

    await upsertStreamer({
      id: streamerId, twitch_id: user.id,
      twitch_login: user.login, twitch_display: user.display_name,
      access_token: tokenData.access_token, refresh_token: tokenData.refresh_token,
      expires_at: nowSec() + tokenData.expires_in
    });

    startEventSub(streamerId).catch(console.error);
    res.redirect(`/dashboard/${streamerId}`);
  } catch (e) {
    console.error(e);
    res.status(500).send(String(e));
  }
});

// Dashboard
app.get('/dashboard/:streamerId', async (req, res) => {
  const streamer = await getStreamer(req.params.streamerId);
  if (!streamer) return res.status(404).send('Not found');
  res.type('html').send(renderDashboard(streamer, req.query.saved));
});

// Save settings
app.post('/dashboard/:streamerId/settings', async (req, res) => {
  const streamer = await getStreamer(req.params.streamerId);
  if (!streamer) return res.status(404).send('Not found');

  const { reward_title, min_num, max_num, panel_bg_color, name_color, num_color } = req.body;

  const minN = Number(min_num);
  const maxN = Number(max_num);

  await updateSettings(streamer.id, {
    reward_title:   reward_title   || streamer.reward_title,
    min_num:        Number.isFinite(minN) && minN > 0 ? minN : streamer.min_num,
    max_num:        Number.isFinite(maxN) && maxN > minN ? maxN : streamer.max_num,
    panel_bg_color: panel_bg_color || streamer.panel_bg_color,
    name_color:     name_color     || streamer.name_color,
    num_color:      num_color      || streamer.num_color,
  });

  res.redirect(`/dashboard/${streamer.id}?saved=1`);
});

// Upload asset
app.post('/dashboard/:streamerId/upload/:assetName', upload.single('file'), async (req, res) => {
  const { streamerId, assetName } = req.params;
  if (!ALLOWED_ASSETS.includes(assetName)) return res.status(400).json({ error: 'Invalid asset name' });

  const streamer = await getStreamer(streamerId);
  if (!streamer) return res.status(404).json({ error: 'Not found' });
  if (!req.file)  return res.status(400).json({ error: 'No file uploaded' });

  res.json({ ok: true, url: `/assets/${streamerId}/${req.file.filename}` });
});

// Overlay page (served by Railway, opened in OBS)
app.get('/overlay/:streamerId', async (req, res) => {
  const streamer = await getStreamer(req.params.streamerId);
  if (!streamer) return res.status(404).send('Not found');
  res.type('html').send(renderOverlay(streamer));
});

// Test trigger
app.get('/test/:streamerId', async (req, res) => {
  const streamer = await getStreamer(req.params.streamerId);
  if (!streamer) return res.status(404).send('Not found');

  const pick   = Number(req.query.pick) || randInt(streamer.min_num, streamer.max_num);
  const rolled = randInt(streamer.min_num, streamer.max_num);
  const result = pick === rolled ? 'win' : 'lose';

  broadcast(streamer.id, {
    type: 'fate_random',
    user:   req.query.user || 'test_viewer',
    pick, rolled, result,
    reward: streamer.reward_title
  });

  res.send(`Sent: pick=${pick} rolled=${rolled} => ${result}`);
});


// ─── Admin panel ──────────────────────────────────────────────────────────────

function adminAuth(req, res, next) {
  const secret = req.query.secret || req.headers['x-admin-secret'] || '';
  if (secret !== ADMIN_SECRET) {
    return res.status(401).type('html').send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>Admin</title>
<style>body{font-family:Inter,sans-serif;background:#0e0e10;color:#efeff1;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#18181b;border-radius:16px;padding:36px;max-width:380px;width:100%;text-align:center}
h2{color:#9146ff;margin:0 0 20px}input{width:100%;padding:10px 14px;background:#0e0e10;border:1px solid #3a3a3d;color:#efeff1;border-radius:8px;font-size:15px;box-sizing:border-box}
button{margin-top:14px;width:100%;padding:12px;background:#9146ff;color:#fff;border:none;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer}</style></head>
<body><div class="card">
  <h2>🔐 Admin</h2>
  <form method="GET" action="/admin">
    <input name="secret" type="password" placeholder="Пароль администратора" autofocus>
    <button type="submit">Войти</button>
  </form>
</div></body></html>`);
  }
  req.adminSecret = secret;
  next();
}

app.get('/admin', adminAuth, async (req, res) => {
  const list = await getWhitelist();
  const secret = req.adminSecret;

  const rows = list.map(w => `
    <tr>
      <td style="padding:10px 14px;font-weight:600">${w.twitch_login}</td>
      <td style="padding:10px 14px;color:#adadb8">${w.note || '—'}</td>
      <td style="padding:10px 14px;color:#adadb8;font-size:12px">${new Date(w.added_at).toLocaleDateString('ru')}</td>
      <td style="padding:10px 14px">
        <form method="POST" action="/admin/remove?secret=${secret}" style="margin:0">
          <input type="hidden" name="login" value="${w.twitch_login}">
          <button type="submit" style="background:rgba(255,77,77,.15);color:#ff4d4d;border:1px solid rgba(255,77,77,.3);padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700">Удалить</button>
        </form>
      </td>
    </tr>`).join('');

  res.type('html').send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Fate Overlay</title>
<style>
  *{box-sizing:border-box} body{font-family:Inter,sans-serif;background:#0e0e10;color:#efeff1;margin:0;padding:20px}
  .page{max-width:700px;margin:0 auto}
  h1{color:#9146ff;margin:0 0 24px;font-size:1.6em}
  .card{background:#18181b;border-radius:14px;padding:24px;margin-bottom:20px}
  h2{margin:0 0 16px;color:#bf94ff;text-transform:uppercase;letter-spacing:.05em;font-size:13px}
  input[type=text]{background:#0e0e10;border:1px solid #3a3a3d;color:#efeff1;padding:9px 12px;border-radius:8px;font-size:14px}
  .btn{background:#9146ff;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700;transition:background .2s}
  .btn:hover{background:#a970ff}
  table{width:100%;border-collapse:collapse}
  tr{border-bottom:1px solid #1f1f23} tr:last-child{border:none}
  tr:hover{background:rgba(255,255,255,.02)}
  .empty{color:#adadb8;text-align:center;padding:20px;font-size:14px}
  .flex{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
  label span{display:block;font-size:12px;color:#adadb8;margin-bottom:4px;font-weight:600}
  .count{background:#9146ff;color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700;margin-left:8px}
</style></head>
<body><div class="page">
  <h1>🎲 Fate Overlay <span style="color:#adadb8;font-size:.5em;font-weight:400">Admin</span></h1>

  <div class="card">
    <h2>Добавить стримера</h2>
    <form method="POST" action="/admin/add?secret=${secret}">
      <div class="flex">
        <label><span>Twitch ник (точно как на канале)</span>
          <input type="text" name="login" placeholder="ник стримера" required style="width:220px">
        </label>
        <label><span>Заметка (опционально)</span>
          <input type="text" name="note" placeholder="оплатил до 01.06" style="width:200px">
        </label>
        <button type="submit" class="btn">+ Добавить</button>
      </div>
    </form>
  </div>

  <div class="card">
    <h2>Разрешённые стримеры <span class="count">${list.length}</span></h2>
    ${list.length === 0
      ? '<div class="empty">Список пуст — никто не может войти</div>'
      : `<table>${rows}</table>`
    }
  </div>

</div></body></html>`);
});

app.post('/admin/add', adminAuth, express.urlencoded({ extended: true }), async (req, res) => {
  const { login, note } = req.body;
  if (login?.trim()) await addToWhitelist(login.trim(), note?.trim() || '');
  res.redirect(`/admin?secret=${req.adminSecret}`);
});

app.post('/admin/remove', adminAuth, express.urlencoded({ extended: true }), async (req, res) => {
  const { login } = req.body;
  if (login) await removeFromWhitelist(login);
  res.redirect(`/admin?secret=${req.adminSecret}`);
});

// ─── HTTP server + WS upgrade ─────────────────────────────────────────────────
const server = app.listen(APP_PORT, async () => {
  try {
    await initDB();
    const all = await getAllStreamersWithTokens();
    for (const s of all) {
      startEventSub(s.id).catch(console.error);
    }
  } catch (e) {
    console.error('❌ Startup error:', e.message);
  }
  console.log(`✅ Server: ${BASE_URL}`);
});

server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }

    const streamerId = url.searchParams.get('id');
    if (!streamerId) { socket.destroy(); return; }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!rooms.has(streamerId)) rooms.set(streamerId, new Set());
      rooms.get(streamerId).add(ws);
      ws.on('close', () => {
        const room = rooms.get(streamerId);
        if (room) { room.delete(ws); if (!room.size) rooms.delete(streamerId); }
      });
      ws.send(JSON.stringify({ type: 'hello' }));
    });
  } catch (e) {
    console.error('WS upgrade error:', e.message);
    socket.destroy();
  }
});

// ─── HTML renderers ───────────────────────────────────────────────────────────

function renderDashboard(streamer, saved) {
  const overlayUrl  = `${BASE_URL}/overlay/${streamer.id}`;
  const testUrl     = `${BASE_URL}/test/${streamer.id}?user=TestViewer&pick=50`;

  const assetList = [
    { key: 'panel_bg',   label: '🖼️ Фон панели',          accept: 'image/*' },
    { key: 'reward_img', label: '🏆 Картинка награды',     accept: 'image/*' },
    { key: 's_in',       label: '🔊 Звук появления',        accept: 'audio/*' },
    { key: 's_roll',     label: '🎲 Звук рандома',          accept: 'audio/*' },
    { key: 's_win',      label: '🎉 Звук победы',           accept: 'audio/*' },
    { key: 's_lose',     label: '😔 Звук проигрыша',        accept: 'audio/*' },
    { key: 's_out',      label: '👋 Звук исчезновения',     accept: 'audio/*' },
  ];

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dashboard — ${streamer.twitch_display}</title>
<style>
  *{box-sizing:border-box} body{font-family:Inter,sans-serif;background:#0e0e10;color:#efeff1;margin:0;padding:20px 16px}
  .page{max-width:760px;margin:0 auto}
  h1{color:#9146ff;margin:0 0 4px;font-size:1.6em}
  .sub{color:#adadb8;margin-bottom:24px;font-size:14px}
  .card{background:#18181b;border-radius:14px;padding:24px;margin-bottom:20px}
  .card h2{margin:0 0 16px;font-size:16px;color:#bf94ff;text-transform:uppercase;letter-spacing:.05em;font-size:13px}
  label{display:block;font-size:13px;color:#adadb8;margin-bottom:12px}
  label span{display:block;margin-bottom:4px;font-weight:600}
  input[type=text],input[type=number]{background:#0e0e10;border:1px solid #3a3a3d;color:#efeff1;padding:9px 12px;border-radius:8px;font-size:14px;width:100%}
  input[type=color]{height:38px;padding:3px 6px;width:56px;border:1px solid #3a3a3d;border-radius:8px;background:#0e0e10;cursor:pointer}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
  button,.btn{background:#9146ff;color:#fff;border:none;padding:10px 20px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:700;text-decoration:none;display:inline-block;transition:background .2s}
  button:hover,.btn:hover{background:#a970ff}
  .btn-sm{padding:7px 14px;font-size:13px}
  .btn-outline{background:transparent;border:1px solid #9146ff;color:#9146ff}
  .btn-outline:hover{background:#9146ff;color:#fff}
  .url-box{background:#0e0e10;border:1px solid #3a3a3d;border-radius:8px;padding:10px 14px;font-size:12px;font-family:monospace;word-break:break-all;color:#bf94ff;margin-bottom:12px}
  .upload-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1f1f23}
  .upload-row:last-child{border-bottom:none}
  .upload-label{min-width:180px;font-size:13px;flex-shrink:0}
  .upload-row input[type=file]{flex:1;font-size:12px;color:#adadb8}
  .success{color:#28d17c;font-size:13px;padding:8px 14px;background:rgba(40,209,124,0.1);border-radius:8px;margin-bottom:16px}
  .flex{display:flex;gap:10px;flex-wrap:wrap}
  @media(max-width:500px){.row,.row3{grid-template-columns:1fr}.upload-row{flex-wrap:wrap}.upload-label{min-width:unset}}
</style></head>
<body><div class="page">
  <h1>🎲 Fate Overlay</h1>
  <p class="sub">Привет, <b>${streamer.twitch_display}</b>!</p>

  ${saved ? '<div class="success">✅ Настройки сохранены!</div>' : ''}

  <div class="card">
    <h2>📺 OBS Browser Source</h2>
    <p style="color:#adadb8;font-size:13px;margin:0 0 8px">Добавь этот URL как Browser Source (размер: 1600×250):</p>
    <div class="url-box">${overlayUrl}</div>
    <div class="flex">
      <button onclick="copyUrl('${overlayUrl}')" class="btn-sm btn">📋 Скопировать</button>
      <a href="${testUrl}" target="_blank" class="btn btn-sm btn-outline">🧪 Тест</a>
    </div>
  </div>

  <div class="card">
    <h2>⚙️ Настройки</h2>
    <form method="POST" action="/dashboard/${streamer.id}/settings">
      <label>
        <span>Название награды (точно как в Twitch Channel Points)</span>
        <input type="text" name="reward_title" value="${esc(streamer.reward_title)}" required>
      </label>
      <div class="row">
        <label><span>Минимальное число</span><input type="number" name="min_num" value="${streamer.min_num}" min="1"></label>
        <label><span>Максимальное число</span><input type="number" name="max_num" value="${streamer.max_num}" min="2"></label>
      </div>
      <div class="row3" style="margin-top:4px">
        <label><span>Фон панели</span><input type="color" name="panel_bg_color" value="${streamer.panel_bg_color}"></label>
        <label><span>Цвет имени</span><input type="color" name="name_color" value="${streamer.name_color}"></label>
        <label><span>Цвет цифр</span><input type="color" name="num_color" value="${streamer.num_color}"></label>
      </div>
      <br><button type="submit">💾 Сохранить</button>
    </form>
  </div>

  <div class="card">
    <h2>🎨 Ассеты (изображения и звуки)</h2>
    <p style="color:#adadb8;font-size:13px;margin:0 0 16px">Загрузи свои файлы. Старые заменятся автоматически.</p>
    ${assetList.map(a => `
    <div class="upload-row">
      <span class="upload-label">${a.label}</span>
      <input type="file" id="f_${a.key}" accept="${a.accept}">
      <button type="button" onclick="uploadAsset('${a.key}')" class="btn btn-sm">Загрузить</button>
      <span id="st_${a.key}" style="font-size:12px;min-width:80px"></span>
    </div>`).join('')}
  </div>

</div>
<script>
function copyUrl(url) {
  navigator.clipboard.writeText(url).then(() => alert('URL скопирован!')).catch(() => prompt('Скопируй:', url));
}
async function uploadAsset(name) {
  const input = document.getElementById('f_' + name);
  const status = document.getElementById('st_' + name);
  if (!input.files[0]) { status.textContent = '⚠️ Выбери файл'; status.style.color='#f59e0b'; return; }
  const fd = new FormData();
  fd.append('file', input.files[0]);
  status.textContent = '⏳...'; status.style.color='#adadb8';
  try {
    const r = await fetch('/dashboard/${streamer.id}/upload/' + name, { method: 'POST', body: fd });
    const j = await r.json();
    if (j.ok) { status.textContent = '✅ OK'; status.style.color='#28d17c'; }
    else       { status.textContent = '❌ Ошибка'; status.style.color='#ff4d4d'; }
  } catch(e) { status.textContent = '❌ ' + e.message; status.style.color='#ff4d4d'; }
}
</script>
</body></html>`;
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

function renderOverlay(streamer) {
  const wsProto = BASE_URL.startsWith('https') ? 'wss' : 'ws';
  const wsHost  = BASE_URL.replace(/^https?:\/\//, '');
  const wsUrl   = `${wsProto}://${wsHost}/ws?id=${streamer.id}`;

  const panelBgUrl  = getAssetUrl(streamer.id, 'panel_bg');
  const rewardImgUrl= getAssetUrl(streamer.id, 'reward_img') || '';
  const sInUrl      = getAssetUrl(streamer.id, 's_in')   || '';
  const sRollUrl    = getAssetUrl(streamer.id, 's_roll') || '';
  const sWinUrl     = getAssetUrl(streamer.id, 's_win')  || '';
  const sLoseUrl    = getAssetUrl(streamer.id, 's_lose') || '';
  const sOutUrl     = getAssetUrl(streamer.id, 's_out')  || '';

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Overlay — ${streamer.twitch_display}</title>
<style>
  :root {
    --panel-w: 1600px; --panel-h: 210px; --panel-top: 40px; --panel-radius: 18px;
    --panel-bg-color: ${streamer.panel_bg_color};
    --white: ${streamer.name_color}; --num-color: ${streamer.num_color};
    --muted: rgba(255,255,255,0.78); --green: #28d17c; --red: #ff4d4d;
    --name-size: 58px; --title-size: 32px; --num-size: 108px; --vs-size: 66px;
    --item-w: 180px; --item-h: 120px; --transition-ms: 650ms;
    --label-bg: rgba(0,0,0,0.45); --label-radius: 10px; --label-pad-y: 6px; --label-pad-x: 12px;
  }
  html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:Inter,Arial,sans-serif}
  #wrap{
    position:absolute;left:50%;top:var(--panel-top);width:var(--panel-w);height:var(--panel-h);
    transform:translate(-50%,-280px);opacity:0;
    border-radius:var(--panel-radius);background-color:var(--panel-bg-color);
    ${panelBgUrl ? `background-image:url("${panelBgUrl}");background-size:cover;background-position:center;` : ''}
    box-shadow:0 14px 45px rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:space-between;
    padding:20px 28px;box-sizing:border-box;
    transition:transform var(--transition-ms) ease, opacity 260ms ease;
  }
  #wrap.show{transform:translate(-50%,0);opacity:1}
  #wrap.hide{transform:translate(-50%,-280px);opacity:0}
  #left{min-width:420px;display:flex;align-items:center;gap:16px}
  #user{font-size:var(--name-size);font-weight:900;color:var(--white);text-shadow:0 6px 24px rgba(0,0,0,0.65);line-height:1.15;padding-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:560px}
  #center{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:flex;align-items:center;gap:28px;pointer-events:none}
  .col{text-align:center}
  .labelWrap{display:inline-block;background:var(--label-bg);border-radius:var(--label-radius);padding:var(--label-pad-y) var(--label-pad-x);box-shadow:0 8px 20px rgba(0,0,0,0.25);margin-bottom:10px}
  .label{font-size:22px;font-weight:800;color:var(--muted);text-shadow:0 3px 12px rgba(0,0,0,0.7);white-space:nowrap;line-height:1}
  .num{font-size:var(--num-size);font-weight:900;color:var(--num-color);line-height:1;min-width:170px;text-shadow:0 10px 28px rgba(0,0,0,0.75)}
  #vs{font-size:var(--vs-size);font-weight:900;color:var(--white);opacity:.92;text-shadow:0 10px 28px rgba(0,0,0,0.75)}
  #right{min-width:560px;display:flex;justify-content:flex-end;align-items:center;gap:16px}
  #rewardTitle{font-size:var(--title-size);font-weight:900;color:var(--white);text-align:right;line-height:1.12;text-shadow:0 6px 24px rgba(0,0,0,0.65);max-width:420px;white-space:normal;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  #rewardImg{width:var(--item-w);height:var(--item-h);object-fit:contain;background:transparent;filter:drop-shadow(0 12px 18px rgba(0,0,0,.5));pointer-events:none;user-select:none}
  #badge{position:absolute;right:26px;bottom:16px;font-size:30px;font-weight:900;padding:10px 18px;border-radius:999px;opacity:0;transform:scale(.95);transition:opacity 200ms ease,transform 200ms ease;text-shadow:0 4px 14px rgba(0,0,0,.65)}
  #badge.show{opacity:1;transform:scale(1)}
  #badge.win{background:rgba(40,209,124,.18);color:var(--green);border:1px solid rgba(40,209,124,.35)}
  #badge.lose{background:rgba(255,77,77,.14);color:var(--red);border:1px solid rgba(255,77,77,.28)}
  .rollFlash{animation:flash .12s linear infinite}
  @keyframes flash{0%,100%{opacity:1}50%{opacity:.55}}
  .shake{animation:shake .5s ease-in-out 1}
  @keyframes shake{0%,100%{transform:translate(-50%,-50%)}20%{transform:translate(calc(-50% - 10px),-50%)}40%{transform:translate(calc(-50% + 10px),-50%)}60%{transform:translate(calc(-50% - 8px),-50%)}80%{transform:translate(calc(-50% + 8px),-50%)}}
</style></head>
<body>
  <div id="wrap" class="hide">
    <div id="left"><div id="user">viewer</div></div>
    <div id="center">
      <div class="col">
        <div class="labelWrap"><div class="label">Число зрителя</div></div>
        <div class="num" id="pickNum">—</div>
      </div>
      <div id="vs">VS</div>
      <div class="col">
        <div class="labelWrap"><div class="label">Число рандома</div></div>
        <div class="num" id="rollNum">—</div>
      </div>
    </div>
    <div id="right">
      <div id="rewardTitle">Награда</div>
      ${rewardImgUrl ? `<img id="rewardImg" src="${rewardImgUrl}" />` : '<div id="rewardImg"></div>'}
    </div>
    <div id="badge"></div>
  </div>

  <audio id="sIn"   src="${sInUrl}"   preload="auto"></audio>
  <audio id="sRoll" src="${sRollUrl}" preload="auto"></audio>
  <audio id="sWin"  src="${sWinUrl}"  preload="auto"></audio>
  <audio id="sLose" src="${sLoseUrl}" preload="auto"></audio>
  <audio id="sOut"  src="${sOutUrl}"  preload="auto"></audio>

<script>
  const WS_URL = "${wsUrl}";
  const wrap=document.getElementById("wrap"),userEl=document.getElementById("user"),
    rewardTitleEl=document.getElementById("rewardTitle"),pickEl=document.getElementById("pickNum"),
    rollEl=document.getElementById("rollNum"),badge=document.getElementById("badge"),
    center=document.getElementById("center"),
    sIn=document.getElementById("sIn"),sRoll=document.getElementById("sRoll"),
    sWin=document.getElementById("sWin"),sLose=document.getElementById("sLose"),sOut=document.getElementById("sOut");

  const T_IN=650,T_STAND=1000,T_ROLL=3000,T_AFTER_RESULT=1000,T_OUT=650;
  let busy=false; const queue=[];
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  function play(a){try{a.pause();a.currentTime=0;a.play();}catch(e){}}
  function resetUI(){
    badge.className="";badge.textContent="";badge.style.opacity=0;
    center.classList.remove("shake");rollEl.classList.remove("rollFlash");
    pickEl.textContent="—";rollEl.textContent="—";
  }
  async function showPanel(){wrap.classList.remove("hide");wrap.classList.add("show");play(sIn);await sleep(T_IN);}
  async function hidePanel(){play(sOut);wrap.classList.remove("show");wrap.classList.add("hide");await sleep(T_OUT);}
  async function runRoll(finalValue){
    play(sRoll);rollEl.classList.add("rollFlash");
    const start=Date.now();
    while(Date.now()-start<T_ROLL){rollEl.textContent=String(Math.floor(Math.random()*100)+1);await sleep(55);}
    rollEl.classList.remove("rollFlash");rollEl.textContent=String(finalValue);await sleep(250);
  }
  function showResult(isWin){
    badge.classList.add("show");
    if(isWin){badge.classList.add("win");badge.textContent="ПОБЕДА!";play(sWin);}
    else{badge.classList.add("lose");badge.textContent="ПРОИГРЫШ";play(sLose);center.classList.add("shake");}
  }
  async function animate(payload){
    if(busy){queue.push(payload);return;}
    busy=true;resetUI();
    userEl.textContent=payload.user||"viewer";
    rewardTitleEl.textContent=payload.reward||"Награда";
    pickEl.textContent=(payload.pick??'—');
    rollEl.textContent="—";
    await showPanel();await sleep(T_STAND);await runRoll(payload.rolled??1);
    showResult(payload.result==="win");
    await sleep(T_AFTER_RESULT);await hidePanel();
    busy=false;if(queue.length)animate(queue.shift());
  }
  function connect(){
    const ws=new WebSocket(WS_URL);
    ws.onmessage=ev=>{try{const d=JSON.parse(ev.data);if(d.type==="fate_random")animate(d);}catch(e){}};
    ws.onclose=()=>setTimeout(connect,1500);
    ws.onerror=()=>ws.close();
  }
  connect();
</script>
</body></html>`;
}
