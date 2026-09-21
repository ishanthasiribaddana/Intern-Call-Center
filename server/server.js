'use strict';
// Intern Call Center - lead collector service.
// One file, no dependencies. Storage is a single JSON file written atomically.
// Auth: shared bearer token. Env: LEAD_TOKEN (required), PORT (default 3700).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3700', 10);
const TOKEN = process.env.LEAD_TOKEN || '';
const DATA_FILE = path.join(__dirname, 'events.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!TOKEN) {
  console.error('LEAD_TOKEN env var is required');
  process.exit(1);
}

let events = [];
try { events = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch {}
if (!Array.isArray(events)) events = [];

function normalisePhone(p) { return String(p || '').replace(/\D/g, ''); }

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(events, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// --- SSE ---
const clients = new Set();
function broadcast(record, kind) {
  const msg = `event: ${kind}\ndata: ${JSON.stringify(record)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch {}
  }
}
setInterval(() => {
  for (const res of clients) { try { res.write(': ping\n\n'); } catch {} }
}, 25000);

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch { resolve(null); }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  const url = new URL(req.url, 'http://x');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (url.pathname === '/health') return json(res, 200, { ok: true, count: events.length });

  // static downloads (installer lives here)
  if (req.method === 'GET' && url.pathname.startsWith('/download')) {
    const name = decodeURIComponent(url.pathname.replace('/download/', '').replace('/download', ''));
    if (!name || name.includes('..')) { res.writeHead(400); return res.end(); }
    const file = path.join(PUBLIC_DIR, name);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return fs.createReadStream(file).pipe(res);
  }

  // auth: header, or ?token= for SSE (EventSource cannot set headers)
  const token = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (token !== TOKEN) return json(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && url.pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    return json(res, 200, events);
  }

  if (req.method === 'POST' && url.pathname === '/api/events') {
    const body = await readBody(req);
    const phone = normalisePhone(body && body.phone);
    if (!body || !phone || !['contact', 'lead'].includes(body.type)) {
      return json(res, 400, { error: 'need type=contact|lead and a phone' });
    }
    const now = new Date().toISOString();
    let rec = events.find((e) => e.id === phone);
    let kind = 'update';
    if (!rec) {
      rec = { id: phone, status: 'New', receivedAt: now };
      events.push(rec);
      kind = 'new';
    }
    // merge: a lead upgrades a contact, never downgrades
    if (body.type === 'lead') rec.type = 'lead';
    else if (!rec.type) rec.type = 'contact';
    for (const k of ['firstName', 'lastName', 'email', 'city', 'name', 'source']) {
      if (body[k]) rec[k] = body[k];
    }
    rec.phone = phone;
    rec.lastSeenAt = now;
    save();
    broadcast(rec, kind);
    return json(res, 200, { ok: true, id: rec.id, kind });
  }

  const m = url.pathname.match(/^\/api\/events\/(\d+)\/status$/);
  if (req.method === 'PATCH' && m) {
    const body = await readBody(req);
    const allowed = ['New', 'Called', 'Interested', 'Not interested'];
    const rec = events.find((e) => e.id === m[1]);
    if (!rec || !body || !allowed.includes(body.status)) {
      return json(res, 400, { error: 'bad id or status' });
    }
    rec.status = body.status;
    save();
    broadcast(rec, 'update');
    return json(res, 200, { ok: true });
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`lead-collector on :${PORT}, ${events.length} events loaded`);
});
