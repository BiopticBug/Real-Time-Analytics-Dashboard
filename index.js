import 'dotenv/config';
import http from 'http';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { MongoClient } from 'mongodb';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import Joi from 'joi';
import { randomUUID } from 'crypto';
import 'dotenv/config';

const PORT = Number(process.env.PORT || 4000);
const MONGODB_URI = process.env.MONGODB_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173').split(',');
const RAW_EVENTS_TTL_DAYS = Number(process.env.RAW_EVENTS_TTL_DAYS || 7);
const MAX_MSG_BYTES = Number(process.env.MAX_MSG_BYTES || 32768);

// Mongo setup
const mongoClient = new MongoClient(MONGODB_URI);
await mongoClient.connect();
const db = mongoClient.db('realtime_analytics');
const eventsCol = db.collection('raw_events');
const aggCol = db.collection('aggregates');

// Indexes & TTL (idempotent and conflict-safe)
async function ensureIndexes() {
  const ttlSeconds = RAW_EVENTS_TTL_DAYS * 86400;
  const existing = await eventsCol.indexes();
  const tsExisting = existing.find(i => i.name === 'ts_1');
  if (tsExisting && tsExisting.expireAfterSeconds !== ttlSeconds) {
    try { await eventsCol.dropIndex('ts_1'); } catch {}
  }
  try { await eventsCol.createIndex({ ts: 1 }, { name: 'ts_1', expireAfterSeconds: ttlSeconds }); } catch {}
  try { await eventsCol.createIndex({ sessionId: 1 }, { name: 'sessionId_1' }); } catch {}
  try { await eventsCol.createIndex({ userId: 1 }, { name: 'userId_1' }); } catch {}
  try { await eventsCol.createIndex({ route: 1 }, { name: 'route_1' }); } catch {}
  try { await eventsCol.createIndex({ eventId: 1 }, { name: 'eventId_1', unique: true }); } catch {}
  try { await aggCol.createIndex({ window: 1, bucketStart: 1 }, { name: 'window_bucketStart_1' }); } catch {}
}
await ensureIndexes();

// In-memory rolling windows (1s, 5s, 60s)
const WINDOW_SIZES = [1, 5, 60];
const memoryWindows = new Map();
for (const w of WINDOW_SIZES) memoryWindows.set(w, new Map());

function getBucketStart(tsMs, windowSec) {
  const bucketMs = windowSec * 1000;
  return Math.floor(tsMs / bucketMs) * bucketMs;
}

// Schemas
const eventSchema = Joi.object({
  eventId: Joi.string().guid({ version: 'uuidv4' }).required(),
  ts: Joi.number().integer().min(0).required(),
  userId: Joi.string().allow('').required(),
  sessionId: Joi.string().required(),
  route: Joi.string().required(),
  action: Joi.string().required(),
  metadata: Joi.object().unknown(true).default({}),
});

// Express app (REST fallback + health + token)
const app = express();
app.set('trust proxy', true);
app.use(helmet());
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '32kb' }));
app.use(morgan('tiny'));
app.use(rateLimit({ windowMs: 1000, limit: 200 }));

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/ready', async (req, res) => {
  try { await db.command({ ping: 1 }); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); }
});

// Issue demo tokens for local dev
app.get('/token', (req, res) => {
  const userId = req.query.userId || 'demo-user';
  const token = jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

// REST ingestion fallback
app.post('/ingest', authHttp, async (req, res) => {
  const payload = req.body;
  if (!payload || (Array.isArray(payload) && payload.length === 0)) return res.status(400).json({ error: 'empty payload' });
  const events = Array.isArray(payload) ? payload : [payload];
  const valid = [];
  for (const e of events) {
    const withDefaults = { metadata: {}, ...e };
    const { value, error } = eventSchema.validate(withDefaults);
    if (error) continue;
    valid.push(value);
  }
  if (valid.length === 0) return res.status(400).json({ error: 'no valid events' });
  await handleEvents(valid);
  res.json({ accepted: valid.length });
});

const server = http.createServer(app);

// WebSocket (ws) server
const wss = new WebSocketServer({ port: PORT + 1, maxPayload: MAX_MSG_BYTES });

// Rooms: map topic->Set of sockets
const topicToSockets = new Map();

function authHttp(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'invalid token' });
  }
}

function authWsFromReq(req) {
  const headers = req.headers || {};
  const auth = headers['authorization'] || headers['Authorization'];
  let token = null;
  if (auth) token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  if (!token && req.url) {
    try {
      const url = new URL(req.url, 'http://localhost');
      token = url.searchParams.get('token');
    } catch {}
  }
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ws connection handler
wss.on('connection', async (ws, req) => {
  const decoded = authWsFromReq(req);
  if (!decoded) {
    try { ws.close(1008, 'unauthorized'); } catch {}
    return;
  }
  ws.user = decoded.sub || 'unknown';
  ws.subscriptions = new Set();

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    const text = data.toString('utf8');
    if (text.length > MAX_MSG_BYTES) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'subscribe' && typeof msg.topic === 'string') {
      subscribe(ws, msg.topic);
      const snapshot = await latestAggregatesSnapshot();
      sendJson(ws, { type: 'agg_snapshot', data: snapshot });
      return;
    }
    if (msg.type === 'events' && Array.isArray(msg.events)) {
      const sanitized = [];
      for (const e of msg.events) {
        const withDefaults = { metadata: {}, ...e };
        const { value, error } = eventSchema.validate(withDefaults);
        if (error) continue;
        sanitized.push(value);
      }
      if (sanitized.length) await handleEvents(sanitized);
      return;
    }
  });

  ws.on('close', () => {
    if (ws.subscriptions) {
      for (const topic of ws.subscriptions) {
        const set = topicToSockets.get(topic);
        if (set) { set.delete(ws); if (set.size === 0) topicToSockets.delete(topic); }
      }
    }
  });
});

function subscribe(ws, topic) {
  let set = topicToSockets.get(topic);
  if (!set) { set = new Set(); topicToSockets.set(topic, set); }
  set.add(ws);
  ws.subscriptions.add(topic);
}

function broadcast(topic, payload) {
  const set = topicToSockets.get(topic);
  if (!set || set.size === 0) return;
  const text = JSON.stringify(payload);
  for (const ws of set) {
    // simple backpressure guard: skip if too buffered
    if (ws.readyState === ws.OPEN && ws.bufferedAmount < 1_000_000) {
      sendJson(ws, null, text);
    }
  }
}

function sendJson(ws, obj, preEncoded) {
  const text = preEncoded || JSON.stringify(obj);
  ws.send(text);
}

async function latestAggregatesSnapshot() {
  const now = Date.now();
  const result = {};
  for (const w of WINDOW_SIZES) {
    const bucketStart = getBucketStart(now, w);
    const key = `${w}s`;
    const map = memoryWindows.get(w);
    const entry = map.get(bucketStart) || { count: 0, uniques: new Set(), routes: new Map(), errors: 0 };
    result[key] = serializeEntry(entry);
  }
  return result;
}

function serializeEntry(entry) {
  return {
    count: entry.count || 0,
    uniques: entry.uniques ? entry.uniques.size : 0,
    routes: Array.from((entry.routes || new Map()).entries()).sort((a,b)=>b[1]-a[1]).slice(0,10),
    errors: entry.errors || 0,
  };
}

async function handleEvents(events) {
  // Idempotent insert of raw events
  if (events.length === 0) return;
  try {
    await eventsCol.insertMany(events, { ordered: false });
  } catch (e) {
    // ignore duplicates
  }
  // Update windows and compute deltas
  const now = Date.now();
  const deltas = {};
  for (const w of WINDOW_SIZES) {
    const map = memoryWindows.get(w);
    const bucketStart = getBucketStart(now, w);
    let entry = map.get(bucketStart);
    if (!entry) { entry = { count: 0, uniques: new Set(), routes: new Map(), errors: 0 }; map.set(bucketStart, entry); }
    for (const ev of events) {
      entry.count += 1;
      if (ev.userId) entry.uniques.add(ev.userId);
      const r = entry.routes.get(ev.route) || 0;
      entry.routes.set(ev.route, r + 1);
      if (ev.action === 'error') entry.errors += 1;
    }
    deltas[`${w}s`] = serializeEntry(entry);
    // Persist aggregate upsert for durability
    await aggCol.updateOne(
      { window: w, bucketStart },
      { $set: { window: w, bucketStart }, $inc: { count: events.length, errors: events.filter(e=>e.action==='error').length }, $setOnInsert: { createdAt: new Date(bucketStart) } },
      { upsert: true }
    );
  }
  broadcast('dashboard:global', { type: 'agg_delta', data: deltas });
}

// Background job: clean old in-memory buckets to bound memory
setInterval(() => {
  const now = Date.now();
  for (const w of WINDOW_SIZES) {
    const map = memoryWindows.get(w);
    for (const [bucketStart] of map) {
      if (bucketStart < now - w * 1000 * 5) { // keep 5 buckets
        map.delete(bucketStart);
      }
    }
  }
}, 5000);

// Start servers
server.listen(PORT, () => {
  console.log(`[server] http listening on :${PORT}`);
});

console.log(`[server] ws listening on :${PORT + 1}`);

