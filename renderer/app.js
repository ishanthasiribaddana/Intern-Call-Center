'use strict';
// Intern Call Center - renderer. Talks straight to the server for the list,
// status changes and the live stream. The bridge in main.js only ingests.

let cfg = null;
let events = [];      // records keyed by id
let filter = 'All';
let search = '';

const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const dotServer = document.getElementById('dot-server');
const dotExt = document.getElementById('dot-ext');
const STATUSES = ['New', 'Called', 'Interested', 'Not interested'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function upsert(rec) {
  const i = events.findIndex((e) => e.id === rec.id);
  if (i >= 0) events[i] = rec; else events.push(rec);
  render();
}

function displayName(r) {
  if (r.firstName || r.lastName) return [r.firstName, r.lastName].filter(Boolean).join(' ');
  return r.name || '';
}

function visible() {
  return events.filter((r) => {
    if (filter === 'New' && r.status !== 'New') return false;
    if (filter === 'Called' && r.status !== 'Called') return false;
    if (filter === 'Leads' && r.type !== 'lead') return false;
    if (search) {
      const hay = (r.phone + ' ' + displayName(r) + ' ' + (r.city || '')).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  }).sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));
}

function render() {
  const list = visible();
  emptyEl.style.display = list.length ? 'none' : 'block';
  rowsEl.innerHTML = list.map((r) => {
    const opts = STATUSES.map((s) =>
      `<option ${s === r.status ? 'selected' : ''}>${s}</option>`).join('');
    return `<tr>
      <td>${esc(r.phone)}</td>
      <td>${esc(displayName(r))}</td>
      <td class="badge-${esc(r.type)}">${esc(r.type)}</td>
      <td>${esc(r.city || '')}</td>
      <td>${esc(r.email || '')}</td>
      <td>${esc(r.source || '')}</td>
      <td>${esc((r.receivedAt || '').replace('T', ' ').slice(0, 16))}</td>
      <td><select data-id="${esc(r.id)}">${opts}</select></td>
    </tr>`;
  }).join('');
}

async function api(path, opts) {
  const r = await fetch(cfg.server + path, Object.assign({
    headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
  }, opts));
  if (!r.ok) throw new Error('server ' + r.status);
  return r.json();
}

async function load() {
  try {
    events = await api('/api/events');
    dotServer.className = 'dot green';
    render();
  } catch {
    dotServer.className = 'dot grey';
  }
}

function connectStream() {
  const es = new EventSource(cfg.server + '/api/stream?token=' + encodeURIComponent(cfg.token));
  es.addEventListener('new', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('update', (e) => upsert(JSON.parse(e.data)));
  es.onopen = () => { dotServer.className = 'dot green'; };
  es.onerror = () => { dotServer.className = 'dot grey'; };
}

// extension bridge liveness
setInterval(async () => {
  try {
    const r = await fetch('http://127.0.0.1:8787/status');
    const s = await r.json();
    dotExt.className = (s.lastEventAt && Date.now() - s.lastEventAt < 60000) ? 'dot green' : 'dot grey';
  } catch { dotExt.className = 'dot grey'; }
}, 5000);

// UI wiring
document.querySelectorAll('.filter').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.filter').forEach((x) => x.classList.remove('on'));
  b.classList.add('on');
  filter = b.dataset.f;
  render();
});
document.getElementById('search').oninput = (e) => { search = e.target.value.toLowerCase(); render(); };
rowsEl.onchange = (e) => {
  if (e.target.tagName !== 'SELECT') return;
  api('/api/events/' + e.target.dataset.id + '/status',
    { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }).catch(() => {});
};
document.getElementById('export').onclick = () => {
  const head = 'phone,name,type,city,email,source,received,status\n';
  const csv = head + visible().map((r) =>
    [r.phone, displayName(r), r.type, r.city || '', r.email || '', r.source || '',
     r.receivedAt || '', r.status]
      .map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'intern_call_center_' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
};

// first run: ask for the employee's name
async function init() {
  cfg = await window.icc.getConfig();
  if (!cfg.name) {
    document.getElementById('name-box').classList.remove('hidden');
    document.getElementById('name-save').onclick = async () => {
      const v = document.getElementById('name-input').value.trim();
      if (!v) return;
      cfg.name = await window.icc.setName(v);
      document.getElementById('name-box').classList.add('hidden');
      document.getElementById('who').textContent = 'signed in as ' + cfg.name;
    };
  } else {
    document.getElementById('who').textContent = 'signed in as ' + cfg.name;
  }
  await load();
  connectStream();
}
init();
