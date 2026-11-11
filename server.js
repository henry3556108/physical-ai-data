// 遠端都更挖土機 demo server：靜態檔、遙測收集、SSE 即時推送、匯出、排行榜。
// 只用 Node 內建模組。啟動：node server.js（PORT 預設 8400，HOST 預設 0.0.0.0）
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { handleWaitlist } from './waitlist/api.js';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8400);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const SESS_DIR = path.join(DATA_DIR, 'sessions');
const INDEX_FILE = path.join(DATA_DIR, 'sessions.json');
const MAX_BODY = 2 * 1024 * 1024;

fs.mkdirSync(SESS_DIR, { recursive: true });

// session 索引：id -> { id, player, latencyMs, startedAt, endedAt, result, samples, events }
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { sessions = {}; }
let saveTimer = null;
function saveIndex() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fsp.writeFile(INDEX_FILE + '.tmp', JSON.stringify(sessions, null, 1))
      .then(() => fsp.rename(INDEX_FILE + '.tmp', INDEX_FILE))
      .catch(e => console.error('save index failed', e));
  }, 200);
}

const STATIC = {
  '/vendor/three.module.js': 'node_modules/three/build/three.module.min.js',
  '/vendor/rapier.es.js': 'node_modules/@dimforge/rapier3d-compat/rapier.es.js',
};
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

// ---------- SSE ----------
const clients = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);

// ---------- helpers ----------
function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
const ID_RE = /^[a-z0-9-]{8,40}$/;
const cleanName = s => String(s || 'Anonymous').replace(/[<>&"'\n\r]/g, '').slice(0, 20) || 'Anonymous';

async function readSessionLines(id) {
  const file = path.join(SESS_DIR, id + '.jsonl');
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  const samples = [], events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      (o.kind === 'event' ? events : samples).push(o);
    } catch { /* 略過壞行 */ }
  }
  return { samples, events };
}

const CSV_COLS = ['t', 'src', 'latencyMs', 'inSwing', 'inArm', 'inBoom', 'inBucket', 'inTrackL', 'inTrackR',
  'dSwing', 'dArm', 'dBoom', 'dBucket',
  'swing', 'boom', 'arm', 'bucket', 'tgtSwing', 'tgtBoom', 'tgtArm', 'tgtBucket',
  'tipX', 'tipY', 'tipZ', 'baseX', 'baseZ', 'heading', 'load', 'impulse'];
function toCsv(rows, cols) {
  const esc = v => v == null ? '' : (typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : `"${String(v).replace(/"/g, '""')}"`);
  return cols.join(',') + '\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\n') + '\n';
}

function leaderboard() {
  return Object.values(sessions)
    .filter(s => s.result && s.result.completed)
    .sort((a, b) => (b.result.score || 0) - (a.result.score || 0))
    .slice(0, 20)
    .map(s => ({ id: s.id, player: s.player, score: s.result.score, stars: s.result.stars,
      time: s.result.time, latencyMs: s.latencyMs, endedAt: s.endedAt }));
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/waitlist' || p.startsWith('/api/waitlist/')) return handleWaitlist(req, res, url, { DATA_DIR, readJson, send });

  if (p === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (p === '/api/session/start' && req.method === 'POST') {
    const b = await readJson(req);
    const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(4).toString('hex');
    sessions[id] = { id, player: cleanName(b.player), latencyMs: Number(b.latencyMs) || 0,
      startedAt: Date.now(), endedAt: null, result: null, samples: 0, events: 0,
      client: String(req.headers['user-agent'] || '').slice(0, 120) };
    saveIndex();
    broadcast('session', sessions[id]);
    return send(res, 200, { id });
  }

  if (p === '/api/telemetry' && req.method === 'POST') {
    const b = await readJson(req);
    const s = ID_RE.test(b.sessionId || '') && sessions[b.sessionId];
    if (!s) return send(res, 404, { error: 'unknown session' });
    const samples = Array.isArray(b.samples) ? b.samples.slice(0, 2000) : [];
    const events = Array.isArray(b.events) ? b.events.slice(0, 500) : [];
    const lines = samples.map(x => JSON.stringify({ kind: 'sample', ...x }))
      .concat(events.map(x => JSON.stringify({ kind: 'event', ...x })));
    if (lines.length) await fsp.appendFile(path.join(SESS_DIR, s.id + '.jsonl'), lines.join('\n') + '\n');
    s.samples += samples.length; s.events += events.length;
    if (b.latencyMs != null) s.latencyMs = Number(b.latencyMs) || 0;
    saveIndex();
    broadcast('telemetry', { sessionId: s.id, player: s.player, latencyMs: s.latencyMs, samples, events });
    return send(res, 200, { ok: true });
  }

  if (p === '/api/session/end' && req.method === 'POST') {
    const b = await readJson(req);
    const s = ID_RE.test(b.sessionId || '') && sessions[b.sessionId];
    if (!s) return send(res, 404, { error: 'unknown session' });
    const r = b.result || {};
    s.endedAt = Date.now();
    s.result = { completed: !!r.completed, score: Math.round(Number(r.score) || 0),
      stars: Math.max(0, Math.min(3, Number(r.stars) || 0)), time: Number(r.time) || 0,
      demolished: Number(r.demolished) || 0, collateral: Number(r.collateral) || 0,
      treasures: Number(r.treasures) || 0, smoothness: Number(r.smoothness) || 0, reason: String(r.reason || '').slice(0, 60) };
    saveIndex();
    broadcast('sessionEnd', s);
    broadcast('leaderboard', leaderboard());
    return send(res, 200, { ok: true, rank: leaderboard().findIndex(x => x.id === s.id) + 1 });
  }

  if (p === '/api/sessions' && req.method === 'GET') {
    return send(res, 200, Object.values(sessions).sort((a, b) => b.startedAt - a.startedAt));
  }

  if (p === '/api/leaderboard' && req.method === 'GET') return send(res, 200, leaderboard());

  let m = p.match(/^\/api\/sessions\/([a-z0-9-]+)\.(json|csv)$/);
  if (m && req.method === 'GET') {
    const [, id, fmt] = m;
    if (!ID_RE.test(id) || !sessions[id]) return send(res, 404, { error: 'not found' });
    const { samples, events } = await readSessionLines(id);
    const disp = n => ({ 'Content-Disposition': `attachment; filename="${n}"` });
    if (fmt === 'json') {
      return send(res, 200, JSON.stringify({ session: sessions[id], samples, events }, null, 1),
        'application/json; charset=utf-8', disp(`excavator-${id}.json`));
    }
    return send(res, 200, toCsv(samples, CSV_COLS), 'text/csv; charset=utf-8', disp(`excavator-${id}.csv`));
  }

  if (p === '/api/export/all.json' && req.method === 'GET') {
    const out = [];
    for (const s of Object.values(sessions)) out.push({ session: s, ...(await readSessionLines(s.id)) });
    return send(res, 200, JSON.stringify(out), 'application/json; charset=utf-8',
      { 'Content-Disposition': 'attachment; filename="excavator-all.json"' });
  }

  if (p === '/api/qr' && req.method === 'GET') {
    const text = String(url.searchParams.get('text') || '').slice(0, 300);
    if (!/^https?:\/\//.test(text)) return send(res, 400, { error: 'bad text' });
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } });
    return send(res, 200, svg, 'image/svg+xml');
  }

  if (p === '/api/info' && req.method === 'GET') {
    // 給遊戲頁產生手機能連的網址（電腦用 localhost 開的時候）
    const ips = Object.values(os.networkInterfaces()).flat()
      .filter(i => i && i.family === 'IPv4' && !i.internal && !/^172\.(1[6-9]|2\d|3[01])\./.test(i.address))
      .map(i => i.address);
    return send(res, 200, { lanUrl: ips.length ? `http://${ips[0]}:${PORT}` : null });
  }

  if (p === '/api/health') return send(res, 200, { ok: true, sessions: Object.keys(sessions).length, viewers: clients.size });

  return send(res, 404, { error: 'not found' });
}

// ---------- static ----------
async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') return redirect(res, '/game/');
  if (p === '/dashboard' || p === '/game' || p === '/pitch' || p === '/waitlist' || p === '/pad') return redirect(res, p + '/');
  let file;
  if (STATIC[p]) file = path.join(ROOT, STATIC[p]);
  else {
    if (p.endsWith('/')) p += 'index.html';
    if (p.startsWith('/waitlist/') && p.endsWith('.js')) return send(res, 404, 'not found', 'text/plain');
    if (!/^\/(game|dashboard|pitch|waitlist|pad)\//.test(p)) return send(res, 404, 'not found', 'text/plain');
    file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  }
  try {
    const data = await fsp.readFile(file);
    const long = p.startsWith('/vendor/');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': long ? 'public, max-age=86400' : 'no-cache' });
    res.end(data);
  } catch { send(res, 404, 'not found', 'text/plain'); }
}
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }

// ---------- 手機遙控器：WebSocket 房間 ----------
// 遊戲端連 /ws?role=game 拿到 4 碼房號；手機連 /ws?role=pad&room=XXXX。
// pad → game：輸入；game → pad：震動、狀態。只做轉送，不保存。
const rooms = new Map(); // room -> { game, pads:Set }
function newRoomCode() {
  for (let i = 0; i < 1000; i++) {
    const c = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(c)) return c;
  }
  throw new Error('no room');
}
function wsSend(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
wss.on('connection', (ws, req, info) => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  if (info.role === 'game') {
    const code = newRoomCode();
    rooms.set(code, { game: ws, pads: new Set() });
    wsSend(ws, { t: 'room', room: code });
    ws.on('message', buf => {
      const r = rooms.get(code); if (!r) return;
      const s = buf.toString().slice(0, 2000);
      for (const pad of r.pads) if (pad.readyState === 1) pad.send(s);
    });
    ws.on('close', () => {
      const r = rooms.get(code);
      if (r) for (const pad of r.pads) wsSend(pad, { t: 'gameGone' });
      rooms.delete(code);
    });
  } else {
    const r = rooms.get(info.room);
    if (!r) { wsSend(ws, { t: 'error', error: 'Room not found. Check the code shown on the game screen.' }); ws.close(); return; }
    r.pads.add(ws);
    wsSend(ws, { t: 'joined', room: info.room });
    wsSend(r.game, { t: 'padJoined', pads: r.pads.size });
    ws.on('message', buf => { if (r.game.readyState === 1) r.game.send(buf.toString().slice(0, 2000)); });
    ws.on('close', () => { r.pads.delete(ws); wsSend(r.game, { t: 'padLeft', pads: r.pads.size }); });
  }
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 10000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(req, res, url);
  } catch (e) {
    console.error(req.method, url.pathname, e.message);
    if (!res.headersSent) send(res, 400, { error: e.message });
    else res.end();
  }
});
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const role = url.searchParams.get('role');
  const room = url.searchParams.get('room') || '';
  if (url.pathname !== '/ws' || !['game', 'pad'].includes(role) || (role === 'pad' && !/^\d{4}$/.test(room))) {
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, { role, room }));
});
server.listen(PORT, HOST, () => console.log(`excavator demo on http://${HOST}:${PORT}`));
