'use strict';
// Intern Call Center - Electron main process.
// Two jobs: a localhost bridge the browser extension POSTs leads to, and the
// window that shows the shared contact list. Never touches WhatsApp.

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BRIDGE_PORT = 8787;
const FLUSH_MS = 30000;

const userData = app.getPath('userData');
const configPath = path.join(userData, 'config.json');
const pendingPath = path.join(userData, 'pending.json');

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  try {
    const def = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.default.json'), 'utf8'));
    cfg = Object.assign({}, def, cfg);
  } catch {}
  return cfg;
}
let config = loadConfig();
let lastEventAt = 0;
let win = null;

// ---------- bridge (extension -> app -> server) ----------

function enqueue(body) {
  let q = [];
  try { q = JSON.parse(fs.readFileSync(pendingPath, 'utf8')); } catch {}
  q.push(body);
  try { fs.writeFileSync(pendingPath, JSON.stringify(q)); } catch {}
}

async function forward(body) {
  // Stamp the employee name as the source when the event didn't carry one.
  let obj = null;
  try { obj = JSON.parse(body); } catch {}
  if (obj && !obj.source && config.name) obj.source = config.name;
  const payload = obj ? JSON.stringify(obj) : body;
  const r = await fetch(config.server + '/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + config.token,
    },
    body: payload,
  });
  if (!r.ok) throw new Error('server ' + r.status);
}

async function forwardOrQueue(body) {
  try { await forward(body); } catch { enqueue(body); }
}

// retry queued posts until the server answers
setInterval(async () => {
  let q = [];
  try { q = JSON.parse(fs.readFileSync(pendingPath, 'utf8')); } catch {}
  while (q.length) {
    try { await forward(q[0]); } catch { break; }
    q.shift();
    try { fs.writeFileSync(pendingPath, JSON.stringify(q)); } catch {}
  }
}, FLUSH_MS);

const bridge = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (req.method === 'GET' && url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, lastEventAt }));
  }

  if (req.method === 'POST' && url.pathname === '/event') {
    // only the extension may post here
    const origin = req.headers.origin || '';
    if (!origin.startsWith('chrome-extension://')) {
      res.writeHead(403); return res.end('forbidden');
    }
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { JSON.parse(b); } catch { res.writeHead(400); return res.end('bad json'); }
      lastEventAt = Date.now();
      forwardOrQueue(b);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  res.writeHead(404); res.end();
});

// ---------- window + tray ----------

function makeIcon() {
  const n = 16, buf = Buffer.alloc(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    buf[i * 4] = 60; buf[i * 4 + 1] = 180; buf[i * 4 + 2] = 110; buf[i * 4 + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: n, height: n });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    title: 'Intern Call Center',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

app.whenReady().then(() => {
  bridge.listen(BRIDGE_PORT, '127.0.0.1');
  app.setLoginItemSettings({ openAtLogin: true });
  createWindow();

  const tray = new Tray(makeIcon());
  tray.setToolTip('Intern Call Center');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: () => { if (win) { win.show(); win.focus(); } } },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { if (win) { win.show(); win.focus(); } });
});

ipcMain.handle('get-config', () => ({
  server: config.server, token: config.token, name: config.name || '',
}));

ipcMain.handle('set-name', (e, name) => {
  config.name = String(name || '').trim();
  try { fs.writeFileSync(configPath, JSON.stringify(config, null, 2)); } catch {}
  return config.name;
});

app.on('window-all-closed', () => {}); // keep running in tray
app.on('before-quit', () => { app.isQuitting = true; });
