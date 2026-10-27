# zupa-whatsapp-ai-agent

WhatsApp AI ordering agent for Gourmet Twist. A sibling service to `zupa-api`, `zupa-crm`, `zupa-kitchen-app` and the Slack bot — it does not share a database with any of them, and only talks to `zupa-api` over HTTP.

See `/home/hayzedd/.claude/plans/cuddly-wishing-fountain.md` for the full design (Context, Workstreams A/B/C, sequencing).

## What this service does

Receives inbound WhatsApp messages forwarded from zupa-api, runs an LLM (Claude) tool-calling loop to build a cart, confirm it, collect delivery/pickup details, create the order, and check for a matching bank-transfer payment — handing off to a human (via zupa-crm) for anything it shouldn't handle itself: complaints, refunds, modifying an existing order, bulk/corporate requests, or whenever it isn't confident.

## Setup

```bash
npm install
cp .env.example .env   # fill in WHATSAPP_AGENT_API_KEY, ANTHROPIC_API_KEY, PAYMENT_* details
npm run dev
```

`WHATSAPP_AGENT_API_KEY` must match the same env var name on the zupa-api side — it's the single shared secret both directions of the integration use (zupa-api calling this service, and this service calling zupa-api).

## Deploying with PM2

```bash
git clone git@github.com:Hayzedd-A/whatsapp-CSR.git
cd whatsapp-CSR
npm install --omit=dev   # better-sqlite3 compiles a native addon — needs build-essential + python3 on the server if not already present (same requirement zupa-api itself has)
cp .env.example .env     # fill in real values — see below
pm2 start ecosystem.config.js
pm2 save                 # so it survives a reboot
pm2 startup              # one-time, follow the printed command (only if this is the first PM2 app on the box)
```

Two things that matter specifically for this service, not just PM2 boilerplate:

- **`instances: 1` in `ecosystem.config.js` is load-bearing, not a default left alone.** This service uses SQLite for session/cart state, which allows exactly one writer process. Never run this under PM2 cluster mode (`-i max` or `instances: "max"`) — two instances writing the same `.db` file will corrupt state or crash. If you ever need more throughput than one process gives you, that's a real scaling conversation (migrate off SQLite), not a PM2 flag.
- **Set `DB_PATH` in `.env` to an absolute path outside the repo checkout** if your deploy process ever replaces the directory (fresh clone/rsync) rather than `git pull` in place — e.g. `/var/lib/whatsapp-agent/agent.db`. If you deploy by `git pull`-ing into the same persistent directory every time (the common PM2 setup), the default relative `./data/agent.db` is fine since the directory itself never disappears. Either way: losing that file loses every in-flight cart and session, so make sure whatever path you pick survives a redeploy.

If this runs on the **same server as zupa-api**, point `WHATSAPP_AGENT_BASE_URL` (on zupa-api's side) at `http://localhost:<PORT>` — no public exposure, reverse proxy, or TLS needed, since the only caller is zupa-api itself on the same box. If it's on a **different server**, it needs to be reachable from wherever zupa-api runs (internal network route, or a reverse-proxied HTTPS endpoint if that's the only path between them) — exposing the raw port to the public internet isn't necessary either way, since the only intended caller is zupa-api.

**Day-to-day**: `pm2 logs whatsapp-agent`, `pm2 restart whatsapp-agent` after a `.env` change (PM2 doesn't reload env vars on its own), `curl localhost:<PORT>/health` to check it's alive. Consider `pm2 install pm2-logrotate` if this is the first long-running PM2 app on the box — logs accumulate indefinitely otherwise.

## Required zupa-api-side configuration

Set these on zupa-api, in addition to this service's own `.env`:
- `WHATSAPP_AGENT_API_KEY` — same value as this service's.
- `WHATSAPP_AGENT_BASE_URL` — this service's base URL, so zupa-api's inbound webhook handler can forward messages here.

## Session storage

SQLite (`better-sqlite3`), not Postgres — see the plan doc's Workstream B section for why. `DB_PATH` **must** point at a persistent volume in any deployed environment; losing that file loses every in-flight cart and session.

## Delivery-zone resolution

Both pickup and home-delivery are now wired end-to-end:
- **Pickup**: `get_pickup_branches` → `GET /customer-requests/stores/:storeId/branches`, resolved into an order via `createBotOrder`'s existing `findActiveBranchByText`/`pickupDeliveryTypeId` logic — the same mechanism `slack-bot/order/new` already uses in production.
- **Delivery**: `search_delivery_zones` → `GET /auth/stores/:storeId`'s `delivery_types`, classified with the exact same name-pattern rules the Slack bot uses (`src/agent/deliveryZones.js`, mirroring Slackbot's `src/data/loader.js`) into named zones vs. Uber/Bolt on-demand tiers, surge variants excluded. The matched zone's `id` becomes `address.cityId` on `create_order`.

The zone matching itself is a simple substring/token match (`searchZones` in `deliveryZones.js`), not the Slack bot's full fuzzy/alias matcher backing its live-typeahead UI — that's a reasonable v1 given the LLM confirms the matched zone name with the customer before proceeding either way. Worth revisiting if the CSR chat-export review shows customers describing areas in ways this simple match handles poorly.

## Status

Workstreams A (zupa-api), B (this service), and C (zupa-crm: mode badge, take-over button, AI-reply forwarding) are all implemented and pushed. Go live in shadow mode first, per the plan.
