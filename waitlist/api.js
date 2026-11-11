// 遠端都更挖土機 waiting list API。只用 Node 內建模組。
//   POST /api/waitlist              報名 { email, name, birthday, website(honeypot) }
//   GET  /api/waitlist/count        公開：{ count }
//   GET  /api/waitlist/list         管理：JSON（需 WAITLIST_ADMIN_TOKEN）
//   GET  /api/waitlist/export.csv   管理：CSV（需 WAITLIST_ADMIN_TOKEN）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE_NAME = 'waitlist.jsonl';
const RATE_LIMIT = 10;          // 每 IP 每分鐘
const RATE_WINDOW_MS = 60_000;
const EMAIL_RE = /^[^\s@"<>()\[\],;:\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ---------- 狀態（以 DATA_DIR 為 key，第一次呼叫時從檔案載入） ----------
const stores = new Map();
function getStore(dataDir) {
  let s = stores.get(dataDir);
  if (s) return s;
  const file = path.join(dataDir, FILE_NAME);
  const emails = new Set();
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* 尚無檔案 */ }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { const o = JSON.parse(line); if (o.email) emails.add(String(o.email).toLowerCase()); } catch { /* 壞行略過 */ }
  }
  s = { file, emails, writeChain: Promise.resolve() };
  stores.set(dataDir, s);
  return s;
}

// ---------- rate limit ----------
const hits = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) if (!arr.some(t => now - t < RATE_WINDOW_MS)) hits.delete(ip);
}, RATE_WINDOW_MS).unref();

function clientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim().slice(0, 64);
  return req.socket?.remoteAddress || 'unknown';
}

// ---------- 驗證 ----------
function validateBirthday(v) {
  const m = DATE_RE.exec(v);
  if (!m) return '生日格式不正確，請用 YYYY-MM-DD';
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '生日不是有效的日期';
  // 以台灣時間（UTC+8）的「今天」為準
  const tw = new Date(Date.now() + 8 * 3600_000);
  const ty = tw.getUTCFullYear(), tm = tw.getUTCMonth() + 1, td = tw.getUTCDate();
  const todayKey = ty * 10000 + tm * 100 + td, bKey = y * 10000 + mo * 100 + d;
  if (bKey > todayKey) return '生日不能是未來的日期';
  let age = ty - y;
  if (tm * 100 + td < mo * 100 + d) age--;
  if (age < 0 || age > 120) return '生日超出合理範圍（0–120 歲）';
  return null;
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '資料格式錯誤' };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const birthday = typeof body.birthday === 'string' ? body.birthday.trim() : '';
  if (!email) return { error: '請填寫 Email' };
  if (email.length > 254 || !EMAIL_RE.test(email)) return { error: 'Email 格式不正確' };
  if (!name) return { error: '請填寫姓名' };
  if ([...name].length > 40) return { error: '姓名最多 40 個字' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { error: '姓名含有不允許的字元' };
  if (!birthday) return { error: '請填寫生日' };
  const bErr = validateBirthday(birthday);
  if (bErr) return { error: bErr };
  return { email, name, birthday };
}

// ---------- 管理驗證 ----------
function checkAdmin(req, url) {
  const expected = process.env.WAITLIST_ADMIN_TOKEN;
  if (!expected) return { code: 503, error: '管理功能未啟用（未設定 WAITLIST_ADMIN_TOKEN）' };
  let given = '';
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) given = auth.replace(/^Bearer\s+/i, '').trim();
  else given = url.searchParams.get('token') || '';
  // 先 hash 成等長再比對，避免長度不同時 timingSafeEqual 丟例外/洩漏長度
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (!given || !crypto.timingSafeEqual(a, b)) return { code: 401, error: '未授權' };
  return null;
}

async function readAll(store) {
  const text = await fsp.readFile(store.file, 'utf8').catch(() => '');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 略過壞行 */ }
  }
  return rows;
}

const CSV_COLS = ['id', 'email', 'name', 'birthday', 'createdAt', 'ip', 'ua'];
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // 防 CSV formula injection
  return '"' + s.replace(/"/g, '""') + '"';
}
function toCsv(rows) {
  return '﻿' + CSV_COLS.join(',') + '\r\n' +
    rows.map(r => CSV_COLS.map(c => csvCell(r[c])).join(',')).join('\r\n') + (rows.length ? '\r\n' : '');
}

// ---------- 入口 ----------
export async function handleWaitlist(req, res, url, ctx) {
  const { DATA_DIR, readJson, send } = ctx;
  const store = getStore(DATA_DIR);
  const p = url.pathname.replace(/\/+$/, '');

  if (p === '/api/waitlist') {
    if (req.method !== 'POST') return send(res, 405, { error: '不支援的請求方法' }, undefined, { Allow: 'POST' });
    const ip = clientIp(req);
    if (rateLimited(ip)) return send(res, 429, { error: '送出太頻繁了，請一分鐘後再試' }, undefined, { 'Retry-After': '60' });

    let body;
    try { body = await readJson(req); } catch { return send(res, 400, { error: '資料格式錯誤' }); }

    // honeypot：有填就假裝成功
    if (body && typeof body === 'object' && typeof body.website === 'string' && body.website.trim()) {
      return send(res, 200, { ok: true, duplicate: false });
    }

    const v = validate(body);
    if (v.error) return send(res, 400, { error: v.error });

    if (store.emails.has(v.email)) return send(res, 200, { ok: true, duplicate: true });
    store.emails.add(v.email); // 同步加入，避免並發重複

    const rec = {
      id: crypto.randomUUID(),
      email: v.email,
      name: v.name,
      birthday: v.birthday,
      createdAt: new Date().toISOString(),
      ip,
      ua: String(req.headers['user-agent'] || '').slice(0, 300),
    };
    const line = JSON.stringify(rec) + '\n';
    const write = store.writeChain.then(async () => {
      await fsp.mkdir(path.dirname(store.file), { recursive: true });
      await fsp.appendFile(store.file, line, { mode: 0o600 });
      await fsp.chmod(store.file, 0o600);
    });
    store.writeChain = write.catch(() => {});
    try { await write; } catch (e) {
      store.emails.delete(v.email);
      console.error('waitlist write failed', e);
      return send(res, 500, { error: '系統暫時無法儲存，請稍後再試' });
    }
    return send(res, 200, { ok: true, duplicate: false });
  }

  if (p === '/api/waitlist/count') {
    if (req.method !== 'GET') return send(res, 405, { error: '不支援的請求方法' }, undefined, { Allow: 'GET' });
    return send(res, 200, { count: store.emails.size });
  }

  if (p === '/api/waitlist/list' || p === '/api/waitlist/export.csv') {
    if (req.method !== 'GET') return send(res, 405, { error: '不支援的請求方法' }, undefined, { Allow: 'GET' });
    const denied = checkAdmin(req, url);
    if (denied) return send(res, denied.code, { error: denied.error });
    const rows = await readAll(store);
    if (p.endsWith('.csv')) {
      const stamp = new Date().toISOString().slice(0, 10);
      return send(res, 200, toCsv(rows), 'text/csv; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="waitlist-${stamp}.csv"` });
    }
    return send(res, 200, { count: rows.length, rows });
  }

  return send(res, 404, { error: '找不到此 API' });
}
