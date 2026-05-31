# Tumbuh — Plant Agent

A plant you pay to water. Anyone can send a watering request (a volume in mL)
to a real plant — **Genesis@Tumbuh, Autonomous Plant #00001**. A phone running
the agent app wakes on a schedule, drives the pump over Bluetooth, snaps a
photo, and settles the payment on **Solana**. The web viewer is a live CCTV
feed of the plant plus a chat-style panel to request water and watch the
history.

## How it works

```
 viewer (web) ──POST /messages {volume_ml}──►  message-api  ──►  D1 (SQLite)
                                                (Cloudflare        messages
                                                 Worker, Hono)     images (R2)
                                                   ▲   │
 plant-agent (Expo app) ── GET /messages/pending ──┘   │ on received=true:
   • Notifee alarm wakes it (even if killed)            │ auto USDC transfer
   • BLE connect to ESP32, read sys_info               │ genesis ──► pump
   • capture photo ──POST /upload──────────────────────┤ (Solana, Helius RPC)
   • operate_pump,<sec> over BLE for duration_sec       │
   • PATCH /messages/:id {received:true} ───────────────┘
                       │ BLE
                       ▼
        pump-operator (ESP32 firmware)
          relay pump on GPIO 18, deep-sleep cycle
```

`message-api` computes `cost_usd` and `duration_sec` for each request from the
pump's `water_rate_usd_per_l` (0.24) and `flow_rate_ml_per_sec` (10). When a
request is first marked `received`, the Worker transfers the USDC from the
genesis wallet to the pump wallet on Solana and stores the signature; the
viewer links it to Solscan.

## Packages

| Package                         | Role                              | Stack                                         |
| ------------------------------- | --------------------------------- | --------------------------------------------- |
| `message-api/`                  | API, database, payments           | Cloudflare Worker, Hono, D1, R2, Solana, JWT  |
| `plant-agent/`                  | The brain — mobile orchestrator   | Expo, React Native, BLE, Notifee              |
| `pump-operator/physical_agent/` | The pump — microcontroller firmware | ESP32 (Arduino `.ino`), BLE                 |
| `viewer/`                       | Public web UI / CCTV feed         | Next.js, React, Tailwind, Solana              |

### `message-api/` — API, database, payments
Cloudflare Worker (Hono) backed by a D1 database and an R2 bucket for plant
photos. Endpoints:

- `GET /config` — genesis plant + pump contacts (rates)
- `GET /messages?contact_id=&page=&limit=` — paginated history
- `GET /messages/pending?contact_id=` — unconfirmed requests for the agent
- `POST /messages` — create a watering request *(JWT)*
- `PATCH /messages/:id` — set `received` / `txn`; first `received=true` triggers the USDC transfer *(JWT)*
- `DELETE /messages/:id` *(JWT)*
- `POST /upload`, `GET /images`, `GET /image/:id` — plant photo feed (R2)
- `GET /read`, `GET /read-receipts` — check-in log

Secrets (`JWT_SECRET`, `GENESIS_PRIVATE_KEY`, `HELIUS_RPC`) are Worker secrets,
not vars — see [wrangler.jsonc](message-api/wrangler.jsonc).

### `plant-agent/` — the brain
Expo / React Native app ("PlantAgent"). Schedules check-ins as a single Notifee
`AlarmManager` trigger that re-arms itself in a linked chain. On each fire it
runs `runScheduledJob` (in HeadlessJS even when the app is killed): connect to
the ESP32 over BLE, read its `sys_info` sleep window, capture and upload a
photo, pull `GET /messages/pending`, run the pump for each request's
`duration_sec` over BLE, then `PATCH` it received. Background-task edge cases
and fixes are documented in [docs/background-tasks.md](docs/background-tasks.md).

### `pump-operator/physical_agent/` — the pump
ESP32 firmware ([physical_agent.ino](pump-operator/physical_agent/physical_agent.ino)).
Relay-driven pump on GPIO 18 (active-LOW). Cycles ~120s awake / ~30s deep sleep
to save power; advertises BLE only while awake. Commands over the BLE write
characteristic: `operate_pump,<seconds>` and `kill`. Sleep takes precedence
over the pump timer.

### `viewer/` — web UI
Next.js app. Full-bleed CCTV view of the plant's photo feed (from
`message-api`'s `/images`) with a chat-style drawer to request water, browse
watering history with Solscan links, and view the genesis wallet's balances
(USDC / JLP on Solana). API base is hardcoded to the deployed Worker.

## Getting started

Each package is standalone.

### message-api (Cloudflare Worker)
```bash
cd message-api
pnpm install
pnpm dev                                         # local wrangler dev
wrangler d1 migrations apply message-api-db      # apply D1 migrations
pnpm deploy                                       # deploy + print a fresh JWT
```
Set secrets with `wrangler secret put JWT_SECRET` (and `GENESIS_PRIVATE_KEY`,
`HELIUS_RPC`). For local dev mirror them in `.dev.vars`.

### plant-agent (Expo)
```bash
cd plant-agent
npm install
npm run android        # or: npm run ios — needs a dev build (BLE + background)
```
Read the versioned Expo SDK 55 docs before editing — see
[plant-agent/AGENTS.md](plant-agent/AGENTS.md).

### pump-operator (ESP32)
Open `pump-operator/physical_agent/physical_agent.ino` in the Arduino IDE (or
arduino-cli), select your ESP32 board, and flash. Reflash after firmware
changes.

### viewer (Next.js)
```bash
cd viewer
npm install
npm run dev            # http://localhost:3000
```

## Deployment

- `message-api` → Cloudflare Workers (`message-api.dhairyashah98.workers.dev`)
- `plant-agent` → installed on the phone beside the plant
- `pump-operator` → flashed to the ESP32 driving the pump
- `viewer` → any Next.js host
