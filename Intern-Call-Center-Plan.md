# Intern Call Center — Desktop App Plan

**Status:** Proposal — not yet approved
**Date:** 2026-09-21
**App name:** Intern Call Center
**Server:** 144.91.123.164 (Contabo VPS, Ubuntu, Nginx — access via `C:\Users\User\.ssh\id_ed25519_temco`)

---

## 1. What it does

The desktop app is a **bridge plus a viewer**. It never touches WhatsApp.

- The existing **browser extension** reads WhatsApp Web and captures lead contacts.
- The extension hands each lead to the **desktop app** over `127.0.0.1` (localhost only).
- The desktop app **forwards the lead to the remote server** and shows the shared list of
  received contact numbers.
- **One app** for both call center and marketing — everyone sees the same list, live.

## 2. The flow

```
WhatsApp Web
   │
   │ (extension already does this — injected.js + leads.js)
   ▼
Browser extension
   │  POST http://127.0.0.1:8787/event
   ▼
Desktop app — local bridge        Desktop app — window
   │                                   ▲
   │ POST http://144.91.123.164:3700   │ GET /api/events
   │        /api/events  (token)       │ + SSE /api/stream (live)
   ▼                                   │
Server (144.91.123.164)               │
   tiny Node service + events.json ───┘
```

- **Why localhost between extension and app:** Chrome's native messaging needs registry
  entries on every employee PC. A localhost POST needs nothing — the extension just sends.
  Binding to `127.0.0.1` only also means **no Windows firewall prompt** during install.
- **IMPORTANT — the POST must come from `background.js`, not a content script.**
  `leads.js` runs on `https://web.whatsapp.com`; a fetch from a secure page to
  `http://127.0.0.1` hits Chrome's Private Network Access rules and can be blocked.
  The service worker is exempt. So: `leads.js` → `chrome.runtime.sendMessage` →
  `background.js` → `fetch('http://127.0.0.1:8787/event')`. The codebase already relays
  DeepSeek API calls through `background.js` the same way.
- **If the app is not running, the lead must not be lost.** Failed POSTs are kept in
  `chrome.storage.local` as a `pending_lead_posts` queue and retried every 30s until the
  bridge answers. Server dedupe on phone makes retries safe.
- **Why SSE for live updates:** simpler than websockets, auto-reconnects, one-way server →
  app push. This is the "webhook-like" channel you asked for. Fallback: poll every 10s.
  SSE pushes **every change** — new contacts, new leads, and status updates — so one
  employee's "Called" mark shows up on everyone else's screen.

## 3. Desktop app

**Tech: Electron**, packaged with electron-builder into a one-click `.exe` installer
(downloadable, double-click install, auto-starts with Windows). One small dependency
tree, same JS skills as the rest of this project.

The app does exactly two things:

| Piece | Job |
|---|---|
| **Local bridge** | `http://127.0.0.1:8787` — accepts `POST /event` from the extension, forwards to the server with the shared token. Replies `{ok:true}` even when offline (queues to disk, retries). Binds to `127.0.0.1` literally — **not** `localhost`, which can resolve to IPv6 and miss the listener. Only accepts requests whose `Origin` is `chrome-extension://…` so other software on the PC cannot inject fake contacts. |
| **Window** | Shows the contacts table (see below). Two connection dots: **server** (green/grey) and **extension** (seen a bridge hit in the last minute). |

### The window content (kept minimal)

| Column / control | Notes |
|---|---|
| Phone number | The contact number — main column |
| Name | First + last, or the WhatsApp chat title |
| Type | `Contact` (just messaged us) or `Lead` (all 5 fields captured) |
| City / Email | When captured — leads only |
| Source | Which employee's WhatsApp it came from |
| Received | Date + time |
| Status dropdown | `New` → `Called` → `Interested` / `Not interested` |
| Filter buttons | `All` / `New` / `Called` / `Leads only` |
| Search box | By number or name |
| Export CSV | For marketing reports |

That's the whole UI. No login screen — see "identity" below.

**Why two types:** a lead needs all 5 fields, but anyone who messages the line leaves a
phone number. `Contact` rows are the raw inbound numbers; `Lead` rows are the complete
ones. Both go in one table — the `Type` column separates them.

### Employee identity

On first run the app asks once: **"Your name"** (e.g. `nimal`). Stored locally, sent as
`source` with every lead. This is how call center and marketing tell whose WhatsApp
produced each number — no accounts, no passwords.

## 4. Server side (144.91.123.164)

**Tech: one small Node.js file** (~150 lines), run by systemd on port `3700`, behind a
shared bearer token.

| Endpoint | Method | Job |
|---|---|---|
| `/api/events` | POST | Append a contact or lead (dedupe on phone) |
| `/api/events` | GET | Return the full list |
| `/api/events/:id/status` | PATCH | Update status from the dropdown |
| `/api/stream` | GET | SSE stream — pushes every change to all connected apps |

**Storage: `events.json`** — one JSON array on disk, written atomically (write temp file,
rename). Matches the "a file in modern technology" instruction. If it ever outgrows a
file, swap the storage layer for SQLite — the API doesn't change.
A daily cron copies `events.json` to `events-YYYYMMDD.json.bak` — it is the only store,
so it gets a backup.

Placed at `/opt/lead-collector/` on the server; nginx already runs there so we can add
TLS later (`leads.<domain>`) — for v1 plain HTTP on port 3700 + token is acceptable for
an internal tool.

## 5. Lead shape (matches what the extension already captures)

```json
{
  "phone": "94771234567",
  "firstName": "Kasun",
  "lastName": "Perera",
  "email": "kasun@example.com",
  "city": "Kandy",
  "source": "nimal",
  "receivedAt": "2026-09-21T10:15:00Z",
  "status": "New"
}
```

## 6. What changes in the extension

Two additions:

1. **Lead saved → forward it.** In `leads.js` after `upsertLead` succeeds, send a runtime
   message to `background.js`, which POSTs to `http://127.0.0.1:8787/event`.
2. **New inbound chat → forward the number.** When the engine sees a message from a
   number we have not seen, send a `contact` event (phone + chat title only — no 5-field
   requirement). Deduped on the server.

- `manifest.json` gains host permission `http://127.0.0.1:8787/*`.
- Failed POSTs go to a `pending_lead_posts` queue in `chrome.storage.local`, retried
  every 30s — a closed app no longer loses leads.
- If the desktop app is never installed, nothing breaks — today's behaviour is kept.

## 7. Install flow for employees

**Do not email the .exe — Gmail strips executable attachments, even zipped.**

1. The installer lives on the server: `http://144.91.123.164:3700/download` (or a static
   file behind nginx).
2. You email employees **the link**, not the file.
3. Employee runs it → Windows SmartScreen warns on unsigned apps → instruct them:
   "More info → Run anyway" (code signing ~$200/yr removes this — not worth it yet).
4. App asks for their name once, sits in the system tray, auto-starts with Windows.
5. Employees who run the WhatsApp line need the browser extension too. View-only staff
   (marketing) need only the app — their bridge just stays idle.

## 8. Security notes (be honest)

- The shared token is baked into the distributed app — anyone with the exe can read the
  lead list. Fine for internal staff; **do not** send it outside the company.
- Leads are personal data (Sri Lanka PDPA No. 9 of 2022). The server file holds names and
  numbers — restrict who gets the app, and mention it in your privacy note to applicants.
- `ufw` is inactive on the server, so port 3700 will be publicly reachable the moment the
  service starts. The bearer token is the only lock — keep it strong and rotate it if an
  installer ever leaks.

## 9. Build order

| # | Step | Where |
|---|---|---|
| 1 | Server: Node service + `events.json` + systemd unit, port 3700, backup cron | `/opt/lead-collector/` |
| 2 | Test endpoints with curl | — |
| 3 | Extension: lead + contact events via `background.js`, pending queue, manifest permission | `leads.js`, `content.js`/`injected.js`, `background.js`, `manifest.json` |
| 4 | Desktop app: bridge + window + tray | this repo |
| 5 | Package installer, host at `/download`, test on a clean PC | electron-builder |
| 6 | One real contact + one real lead end-to-end | — |

## 9b. Gaps found on review (2026-09-21) — now folded into the plan

| # | Gap | Fix |
|---|---|---|
| 1 | Content-script fetch to `127.0.0.1` can be blocked (Private Network Access) | POST moved to `background.js` service worker |
| 2 | Plan only sent complete leads — plain inbound numbers were invisible | New `contact` event type; table has a `Type` column |
| 3 | App closed = lead lost | `pending_lead_posts` queue in `chrome.storage`, retried |
| 4 | Gmail strips .exe attachments | Installer hosted on the server, employees get a link |
| 5 | SSE only pushed new items | Pushes status changes too |
| 6 | `localhost` can resolve to IPv6; junk POSTs from other software | Bind `127.0.0.1` literally; check `Origin` header |
| 7 | `events.json` is the only store | Daily `.bak` copy via cron |
| 8 | Verified on server: Node 20 present, port 3700 free, `ufw` inactive | Token is the only auth — keep it strong, rotate if an exe leaks |

## 10. Open questions

1. **Port or domain?** v1 uses `http://144.91.123.164:3700` (fastest). If we want HTTPS,
   add an nginx site with a subdomain — needs a DNS entry.
2. **Delete rights?** Can staff delete a lead, or only admins? (Default plan: no delete
   in the app, only status changes — safer.)
3. **One WhatsApp or many?** The design works either way — each install just tags leads
   with the employee's name.
