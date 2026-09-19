// Voxa — сервер: комнаты, текстовый чат, присутствие, выдача токенов LiveKit.
// Без внешних зависимостей: node:http + node:sqlite + SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { LiveKit } from './livekit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfg = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3000),
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, 'public'),
  serverPassword: process.env.SERVER_PASSWORD || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  serverName: process.env.SERVER_NAME || 'Voxa',
  livekitKey: process.env.LIVEKIT_API_KEY || 'devkey',
  livekitSecret: process.env.LIVEKIT_API_SECRET || 'secret',
  // адрес LiveKit для браузера (wss://домен) — если пусто, берётся тот же хост, что и у сайта
  livekitPublicUrl: process.env.LIVEKIT_PUBLIC_URL || '',
  // адрес LiveKit для сервера (API/Twirp)
  livekitInternalUrl: process.env.LIVEKIT_INTERNAL_URL || 'http://127.0.0.1:7880',
  maxRooms: Number(process.env.MAX_ROOMS || 100),
};

fs.mkdirSync(cfg.dataDir, { recursive: true });
const lk = new LiveKit({
  apiKey: cfg.livekitKey,
  apiSecret: cfg.livekitSecret,
  internalUrl: cfg.livekitInternalUrl,
});

// ---------------------------------------------------------------- база данных
const db = new DatabaseSync(path.join(cfg.dataDir, 'voxa.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    topic TEXT NOT NULL DEFAULT '',
    password_hash TEXT,
    user_limit INTEGER NOT NULL DEFAULT 0,
    owner_id INTEGER,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, id);
  CREATE TABLE IF NOT EXISTS room_access (
    user_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, room_id)
  );
`);
db.exec('PRAGMA foreign_keys = ON;');

if (db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n === 0) {
  const ins = db.prepare('INSERT INTO rooms (name, topic, position, created_at) VALUES (?, ?, ?, ?)');
  ins.run('Общий', 'Болтаем обо всём', 0, Date.now());
  ins.run('Игры', 'Катки и стримы', 1, Date.now());
}

const COLORS = ['#5865f2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#3ba55d', '#faa61a', '#00b0f4', '#9b59b6', '#e67e22'];

// ---------------------------------------------------------------- утилиты
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function checkPassword(pw, stored) {
  if (!stored) return true;
  const [saltHex, hashHex] = stored.split(':');
  const hash = crypto.scryptSync(String(pw || ''), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const lkRoomName = (id) => `room-${id}`;
const roomIdFromLk = (name) => {
  const m = /^room-(\d+)$/.exec(name || '');
  return m ? Number(m[1]) : null;
};
const cleanText = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// простой ограничитель частоты: key -> массив отметок времени
const hits = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) throw new HttpError(429, 'Слишком часто, подождите немного');
  arr.push(now);
  hits.set(key, arr);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) if (!arr.some((t) => now - t < 120_000)) hits.delete(k);
}, 60_000).unref();

// ---------------------------------------------------------------- присутствие в голосе
// roomId -> Map(identity -> { id, name, color, screen, camera })
const presence = new Map();

function userById(id) {
  return db.prepare('SELECT id, name, color, is_admin FROM users WHERE id = ?').get(Number(id));
}

function setParticipant(roomId, p) {
  if (!presence.has(roomId)) presence.set(roomId, new Map());
  const room = presence.get(roomId);
  const prev = room.get(p.identity) || {};
  const user = userById(p.identity);
  room.set(p.identity, {
    id: Number(p.identity),
    name: user?.name || p.name || 'Гость',
    color: user?.color || '#5865f2',
    screen: prev.screen || false,
    camera: prev.camera || false,
    joinedAt: prev.joinedAt || Date.now(),
  });
}

function removeParticipant(roomId, identity) {
  presence.get(roomId)?.delete(identity);
}

function isScreenSource(src) {
  return src === 'SCREEN_SHARE' || src === 3;
}
function isCameraSource(src) {
  return src === 'CAMERA' || src === 1;
}

async function resyncPresence() {
  try {
    const rooms = await lk.listRooms();
    presence.clear();
    for (const r of rooms) {
      const roomId = roomIdFromLk(r.name);
      if (!roomId) continue;
      const parts = await lk.listParticipants(r.name);
      for (const p of parts) {
        setParticipant(roomId, p);
        const entry = presence.get(roomId).get(p.identity);
        entry.screen = (p.tracks || []).some((t) => isScreenSource(t.source));
        entry.camera = (p.tracks || []).some((t) => isCameraSource(t.source) && !t.muted);
      }
    }
    broadcastRooms();
  } catch (e) {
    console.warn('[livekit] синхронизация присутствия не удалась:', e.message);
  }
}

// ---------------------------------------------------------------- SSE
const clients = new Set(); // { res, userId }

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const c of clients) sendEvent(c.res, event, data);
}

// доступ к закрытой комнате: владелец, админ или тот, кто уже ввёл пароль
function hasAccess(user, room) {
  if (!room.password_hash) return true;
  if (user.isAdmin || user.is_admin || room.owner_id === user.id) return true;
  return !!db.prepare('SELECT 1 FROM room_access WHERE user_id = ? AND room_id = ?').get(user.id, room.id);
}
function grantAccess(user, room) {
  db.prepare('INSERT OR IGNORE INTO room_access (user_id, room_id) VALUES (?, ?)').run(user.id, room.id);
}

function roomsPayload(user) {
  const rows = db.prepare('SELECT * FROM rooms ORDER BY position, id').all();
  return rows.map((r) => ({
    access: user ? hasAccess(user, r) : false,
    id: r.id,
    name: r.name,
    topic: r.topic,
    locked: !!r.password_hash,
    userLimit: r.user_limit,
    ownerId: r.owner_id,
    participants: [...(presence.get(r.id)?.values() || [])].sort((a, b) => a.joinedAt - b.joinedAt),
  }));
}
let roomsTimer = null;
function broadcastRooms() {
  // склеиваем частые обновления
  if (roomsTimer) return;
  roomsTimer = setTimeout(() => {
    roomsTimer = null;
    for (const c of clients) {
      const u = userById(c.userId);
      if (u) sendEvent(c.res, 'rooms', roomsPayload(u));
    }
  }, 100);
}
function onlineUsers() {
  const map = new Map();
  for (const c of clients) {
    const u = userById(c.userId);
    if (u) map.set(u.id, { id: u.id, name: u.name, color: u.color });
  }
  return [...map.values()];
}
function broadcastOnline() {
  broadcast('online', onlineUsers());
}

setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 25_000).unref();

// ---------------------------------------------------------------- HTTP-хелперы
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Некорректный JSON');
  }
}

function auth(req, url) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
  if (!token) throw new HttpError(401, 'Нужно войти');
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.color, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token);
  if (!row) throw new HttpError(401, 'Сессия устарела, войдите снова');
  return { ...row, isAdmin: !!row.is_admin, token };
}

function getRoom(id) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(id));
  if (!room) throw new HttpError(404, 'Комната не найдена');
  return room;
}

const publicUser = (u) => ({ id: u.id, name: u.name, color: u.color, isAdmin: !!(u.isAdmin ?? u.is_admin) });

function livekitUrlFor(req) {
  if (cfg.livekitPublicUrl) return cfg.livekitPublicUrl;
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}`;
}

// ---------------------------------------------------------------- маршруты API
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', /^\/api\/info$/, (req, res) => {
  json(res, 200, { name: cfg.serverName, passwordRequired: !!cfg.serverPassword });
});

route('POST', /^\/api\/login$/, async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  rateLimit(`login:${ip}`, 10, 60_000);
  const body = await readJson(req);
  const name = cleanText(body.name, 32);
  if (name.length < 2) throw new HttpError(400, 'Ник должен быть от 2 до 32 символов');
  const password = String(body.password || '');
  let isAdmin = false;
  if (cfg.adminPassword && password && safeEqual(password, cfg.adminPassword)) isAdmin = true;
  else if (cfg.serverPassword && !safeEqual(password, cfg.serverPassword))
    throw new HttpError(403, 'Неверный пароль сервера');

  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, color, is_admin, created_at) VALUES (?, ?, ?, ?)')
    .run(name, color, isAdmin ? 1 : 0, Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)').run(token, lastInsertRowid, Date.now());
  json(res, 200, { token, user: publicUser({ id: Number(lastInsertRowid), name, color, isAdmin }) });
});

route('GET', /^\/api\/me$/, (req, res, url) => {
  json(res, 200, { user: publicUser(auth(req, url)) });
});

route('PATCH', /^\/api\/me$/, async (req, res, url) => {
  const user = auth(req, url);
  const body = await readJson(req);
  const name = body.name !== undefined ? cleanText(body.name, 32) : user.name;
  if (name.length < 2) throw new HttpError(400, 'Ник должен быть от 2 до 32 символов');
  const color = /^#[0-9a-f]{6}$/i.test(body.color || '') ? body.color : user.color;
  db.prepare('UPDATE users SET name = ?, color = ? WHERE id = ?').run(name, color, user.id);
  for (const room of presence.values()) {
    const p = room.get(String(user.id));
    if (p) Object.assign(p, { name, color });
  }
  broadcastRooms();
  broadcastOnline();
  json(res, 200, { user: publicUser({ ...user, name, color }) });
});

route('POST', /^\/api\/logout$/, (req, res, url) => {
  const user = auth(req, url);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(user.token);
  json(res, 200, { ok: true });
});

route('GET', /^\/api\/rooms$/, (req, res, url) => {
  const user = auth(req, url);
  json(res, 200, { rooms: roomsPayload(user) });
});

route('POST', /^\/api\/rooms$/, async (req, res, url) => {
  const user = auth(req, url);
  rateLimit(`room:${user.id}`, 5, 60_000);
  const body = await readJson(req);
  const name = cleanText(body.name, 40);
  if (!name) throw new HttpError(400, 'Укажите название комнаты');
  if (db.prepare('SELECT COUNT(*) AS n FROM rooms').get().n >= cfg.maxRooms)
    throw new HttpError(400, 'Достигнут лимит комнат на сервере');
  const topic = cleanText(body.topic, 120);
  const pw = String(body.password || '');
  const limit = Math.max(0, Math.min(99, Number(body.userLimit) || 0));
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM rooms').get().p;
  const { lastInsertRowid } = db
    .prepare(
      'INSERT INTO rooms (name, topic, password_hash, user_limit, owner_id, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(name, topic, pw ? hashPassword(pw) : null, limit, user.id, pos, Date.now());
  broadcastRooms();
  json(res, 200, { id: Number(lastInsertRowid) });
});

function assertCanManage(user, room) {
  if (!user.isAdmin && room.owner_id !== user.id) throw new HttpError(403, 'Только создатель комнаты может это сделать');
}

route('PATCH', /^\/api\/rooms\/(\d+)$/, async (req, res, url, [id]) => {
  const user = auth(req, url);
  const room = getRoom(id);
  assertCanManage(user, room);
  const body = await readJson(req);
  const name = body.name !== undefined ? cleanText(body.name, 40) : room.name;
  if (!name) throw new HttpError(400, 'Укажите название комнаты');
  const topic = body.topic !== undefined ? cleanText(body.topic, 120) : room.topic;
  const limit = body.userLimit !== undefined ? Math.max(0, Math.min(99, Number(body.userLimit) || 0)) : room.user_limit;
  let pwHash = room.password_hash;
  if (body.password !== undefined) {
    pwHash = body.password ? hashPassword(String(body.password)) : null;
    db.prepare('DELETE FROM room_access WHERE room_id = ?').run(room.id); // новый пароль — старые допуски сбрасываются
  }
  db.prepare('UPDATE rooms SET name = ?, topic = ?, user_limit = ?, password_hash = ? WHERE id = ?').run(
    name,
    topic,
    limit,
    pwHash,
    room.id,
  );
  broadcastRooms();
  json(res, 200, { ok: true });
});

route('DELETE', /^\/api\/rooms\/(\d+)$/, async (req, res, url, [id]) => {
  const user = auth(req, url);
  const room = getRoom(id);
  assertCanManage(user, room);
  db.prepare('DELETE FROM messages WHERE room_id = ?').run(room.id);
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  presence.delete(room.id);
  lk.deleteRoom(lkRoomName(room.id)).catch(() => {});
  broadcast('room_deleted', { id: room.id });
  broadcastRooms();
  json(res, 200, { ok: true });
});

function checkRoomPassword(user, room, password) {
  if (hasAccess(user, room)) return;
  rateLimit(`roompw:${user.id}`, 10, 60_000);
  if (!checkPassword(password, room.password_hash)) throw new HttpError(403, 'Неверный пароль комнаты');
  grantAccess(user, room);
}

// Ввод пароля комнаты (открывает чат без входа в голос)
route('POST', /^\/api\/rooms\/(\d+)\/unlock$/, async (req, res, url, [id]) => {
  const user = auth(req, url);
  const room = getRoom(id);
  const body = await readJson(req);
  checkRoomPassword(user, room, body.password);
  broadcastRooms();
  json(res, 200, { ok: true });
});

// Вход в голосовую комнату: проверка пароля/лимита и выдача токена LiveKit
route('POST', /^\/api\/rooms\/(\d+)\/join$/, async (req, res, url, [id]) => {
  const user = auth(req, url);
  const room = getRoom(id);
  const body = await readJson(req);
  checkRoomPassword(user, room, body.password);
  const current = presence.get(room.id);
  if (room.user_limit && current && current.size >= room.user_limit && !current.has(String(user.id)))
    throw new HttpError(403, `Комната заполнена (${room.user_limit})`);
  const token = lk.participantToken({
    identity: String(user.id),
    name: user.name,
    room: lkRoomName(room.id),
    metadata: JSON.stringify({ color: user.color }),
  });
  json(res, 200, { url: livekitUrlFor(req), token, room: lkRoomName(room.id) });
});

function assertAccess(user, room) {
  if (!hasAccess(user, room)) throw new HttpError(403, 'Комната закрыта паролем');
}

route('GET', /^\/api\/rooms\/(\d+)\/messages$/, (req, res, url, [id]) => {
  const user = auth(req, url);
  const room = getRoom(id);
  assertAccess(user, room);
  const before = Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER;
  const rows = db
    .prepare(
      'SELECT id, user_id AS userId, name, color, text, created_at AS ts FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT 50',
    )
    .all(room.id, before);
  json(res, 200, { messages: rows.reverse() });
});

route('POST', /^\/api\/rooms\/(\d+)\/messages$/, async (req, res, url, [id]) => {
  const user = auth(req, url);
  const room = getRoom(id);
  assertAccess(user, room);
  rateLimit(`msg:${user.id}`, 20, 10_000);
  const body = await readJson(req);
  const text = cleanText(body.text, 2000);
  if (!text) throw new HttpError(400, 'Пустое сообщение');
  const ts = Date.now();
  const { lastInsertRowid } = db
    .prepare('INSERT INTO messages (room_id, user_id, name, color, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(room.id, user.id, user.name, user.color, text, ts);
  const msg = { id: Number(lastInsertRowid), roomId: room.id, userId: user.id, name: user.name, color: user.color, text, ts };
  for (const c of clients) {
    const u = userById(c.userId);
    if (u && hasAccess(u, room)) sendEvent(c.res, 'message', msg);
  }
  json(res, 200, { message: msg });
});

route('DELETE', /^\/api\/messages\/(\d+)$/, (req, res, url, [id]) => {
  const user = auth(req, url);
  const msg = db.prepare('SELECT m.*, r.owner_id FROM messages m JOIN rooms r ON r.id = m.room_id WHERE m.id = ?').get(Number(id));
  if (!msg) throw new HttpError(404, 'Сообщение не найдено');
  if (msg.user_id !== user.id && msg.owner_id !== user.id && !user.isAdmin) throw new HttpError(403, 'Нельзя удалить чужое сообщение');
  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  broadcast('message_deleted', { id: msg.id, roomId: msg.room_id });
  json(res, 200, { ok: true });
});

// Поток событий (SSE)
route('GET', /^\/api\/events$/, (req, res, url) => {
  const user = auth(req, url);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, userId: user.id };
  clients.add(client);
  sendEvent(res, 'rooms', roomsPayload(user));
  broadcastOnline();
  req.on('close', () => {
    clients.delete(client);
    broadcastOnline();
  });
});

// Вебхуки LiveKit: кто зашёл/вышел, кто показывает экран
route('POST', /^\/api\/livekit\/webhook$/, async (req, res) => {
  const raw = await readBody(req, 1024 * 1024);
  if (!lk.verifyWebhook(raw, req.headers.authorization)) throw new HttpError(401, 'bad signature');
  const ev = JSON.parse(raw.toString('utf8'));
  const roomId = roomIdFromLk(ev.room?.name);
  if (roomId) {
    const identity = ev.participant?.identity;
    switch (ev.event) {
      case 'participant_joined':
        setParticipant(roomId, ev.participant);
        break;
      case 'participant_left':
        removeParticipant(roomId, identity);
        break;
      case 'track_published':
      case 'track_unpublished': {
        const entry = presence.get(roomId)?.get(identity);
        if (entry) {
          const on = ev.event === 'track_published';
          if (isScreenSource(ev.track?.source)) entry.screen = on;
          if (isCameraSource(ev.track?.source)) entry.camera = on;
        }
        break;
      }
      case 'room_finished':
        presence.delete(roomId);
        break;
    }
    broadcastRooms();
  }
  json(res, 200, { ok: true });
});

route('GET', /^\/healthz$/, (req, res) => json(res, 200, { ok: true }));

// ---------------------------------------------------------------- статика
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.normalize(path.join(cfg.publicDir, rel));
  if (!file.startsWith(cfg.publicDir)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(cfg.publicDir, 'index.html');
  if (!fs.existsSync(file)) return json(res, 404, { error: 'Клиент не собран: запустите сборку web/' });
  const ext = path.extname(file);
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- сервер
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('permissions-policy', 'camera=(self), microphone=(self), display-capture=(self)');
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (m) return await r.handler(req, res, url, m.slice(1));
      }
      throw new HttpError(404, 'Не найдено');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Внутренняя ошибка сервера' : e.message });
    else res.end();
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`Voxa запущен на http://${cfg.host}:${cfg.port}`);
  resyncPresence();
});
// периодически сверяемся с LiveKit на случай потерянных вебхуков
setInterval(resyncPresence, 60_000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const c of clients) c.res.end();
    server.close();
    db.close();
    process.exit(0);
  });
}
