# zupa-whatsapp-ai-agent

WhatsApp AI ordering agent for Gourmet Twist. A sibling service to `zupa-api`, `zupa-crm`, `zupa-kitchen-app` and the Slack bot — it does not share a database with any of them, and only talks to `zupa-api` over HTTP.

See `/home/hayzedd/.claude/plans/cuddly-wishing-fountain.md` for the full design (Context, Workstreams A/B/C, sequencing).

## What this service does

Receives inbound WhatsApp messages forwarded from zupa-api, runs an LLM tool-calling loop to build a cart, confirm it, collect delivery/pickup details, verify a bank-transfer payment, and only then create the order — handing off to a human (via zupa-crm) for anything it shouldn't handle itself: complaints, refunds, modifying an existing order, bulk/corporate requests, or whenever it isn't confident.

## LLM provider

`AI_PROVIDER` picks the model: `openai` (default — the primary provider across the rest of the stack) or `claude`/`anthropic` (backup). Same switch, same convention, as the Slack bot's `src/parser/ai-client.js`. Only the active provider's API key needs to be set (`OPENAI_API_KEY`/`OPENAI_MODEL`, or `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL`) — see `.env.example`.

The two providers are implemented as adapters under `src/agent/providers/` (`openai.js`, `anthropic.js`, selected by `providers/index.js`), both exposing the same `{ runTurn, toolResultRow, buildApiMessages }` shape so `agent/orchestrator.js` doesn't know or care which one is active. Tool definitions (`src/agent/tools.js`) are written once in Anthropic's `{ name, description, input_schema }` shape; the OpenAI adapter converts them to its own function-tool format. Conversation history is persisted per-provider in its own native wire format (an OpenAI-mode row isn't replayable by the Anthropic adapter and vice versa) — switching `AI_PROVIDER` only takes effect for new conversations; a conversation already in flight when you switch will hit a shape mismatch on its next turn, which the existing turn-level error handling catches and escalates to a human rather than crashing.

## Order creation is payment-gated — on purpose, enforced in code

There is exactly one place in this entire service that calls zupa-api's order-creation endpoint: inside `check_payment`'s executor (`src/agent/tools.js`), and only in the branch where `verifyPayment` reports a match. No other tool, and no path through `confirm_order_details`, ever creates an order. This isn't just prompt guidance (an earlier version relied on that, and it failed in testing — the model created an order before even showing the customer the payment details) — it's structural: `confirm_order_details` only writes to the local SQLite session (`pendingOrder`), and the order payload used by `check_payment` is built entirely from that locally-held state plus the payment reference it just matched, so there's no code path left that can call `zupaApi.createOrder` without a payment reference already in hand.

## Setup

```bash
npm install
cp .env.example .env   # fill in WHATSAPP_AGENT_API_KEY, OPENAI_API_KEY (or AI_PROVIDER=claude + ANTHROPIC_API_KEY), PAYMENT_* details
npm run dev
```

`WHATSAPP_AGENT_API_KEY` must match the same env var name on the zupa-api side — it's the single shared secret both directions of the integration use (zupa-api calling this service, and this service calling zupa-api).

## Deploying with PM2

Runs on the same droplet as the Slack bot. That bot defaults to port 3000 (`PORT` in its own `.env`); this service defaults to `4100` — no collision, but check `pm2 list` for anything else already running there before assuming any default port is free.

```bash
git clone git@github.com:Hayzedd-A/whatsapp-CSR.git
cd whatsapp-CSR
npm install --omit=dev   # better-sqlite3 compiles a native addon — needs build-essential + python3 on the server if not already present
cp .env.example .env     # fill in real values — see below
pm2 start ecosystem.config.js
pm2 save                 # re-run this after adding the app — needed so a reboot restarts it too
```

Skip `pm2 startup` — if the Slack bot already runs under PM2 on this box, that one-time step (registering PM2 itself with the OS's init system) has already been done; `pm2 save` alone is what picks up this new app for next boot. Only run `pm2 startup` if `pm2 list` shows nothing at all on this box yet.

**Networking — this box is probably not where zupa-api runs.** The Slack bot deploys via a bare SSH script to its own droplet; zupa-api deploys as a Docker container, most likely elsewhere. That means `WHATSAPP_AGENT_BASE_URL` (set on zupa-api) needs this droplet's actual reachable address, not `localhost`. Don't expose port 4100 to the open internet as-is — the bearer-token check is the only thing guarding it otherwise. Pick one:
- If zupa-api's host and this droplet share a cloud provider's private network/VPC, use the private IP — no public exposure at all.
- Otherwise, put this behind a reverse proxy (nginx) with TLS, and restrict inbound access to zupa-api's IP via the droplet's firewall (`ufw`, or your cloud provider's security-group/firewall rules) — the same way you'd think about any other internal service-to-service call that happens to cross the public internet.

Two things that matter specifically for this service, not just PM2 boilerplate:

- **`instances: 1` in `ecosystem.config.js` is load-bearing, not a default left alone.** This service uses SQLite for session/cart state, which allows exactly one writer process. Never run this under PM2 cluster mode (`-i max` or `instances: "max"`) — two instances writing the same `.db` file will corrupt state or crash. If you ever need more throughput than one process gives you, that's a real scaling conversation (migrate off SQLite), not a PM2 flag.
- **Set `DB_PATH` in `.env` to an absolute path outside the repo checkout** if your deploy process ever replaces the directory (fresh clone/rsync) rather than `git pull` in place — e.g. `/var/lib/whatsapp-agent/agent.db`. If you deploy by `git pull`-ing into the same persistent directory every time (the common PM2 setup), the default relative `./data/agent.db` is fine since the directory itself never disappears. Either way: losing that file loses every in-flight cart and session, so make sure whatever path you pick survives a redeploy.

**Day-to-day**: `pm2 logs whatsapp-agent`, `pm2 restart whatsapp-agent` after a `.env` change (PM2 doesn't reload env vars on its own), `curl localhost:<PORT>/health` to check it's alive. Consider `pm2 install pm2-logrotate` if this is the first long-running PM2 app on the box — logs accumulate indefinitely otherwise. For anything beyond a quick `pm2 logs` tail, see the `/logs` viewer below.

## Auto-deploy (GitHub Actions)

`.github/workflows/deploy.yml` runs on every push to `main`: a no-SSH `verify` job (syntax-checks every file on a throwaway runner) must pass before a second job SSHes into the droplet and runs `git pull && npm install --omit=dev && pm2 startOrRestart ecosystem.config.js`.

Add these repo secrets (Settings → Secrets and variables → Actions) before the first push — they're scoped to this repo specifically, not shared with the Slack bot's repo even though it deploys to the same box:
- `SERVER_HOST` — the droplet's address.
- `SERVER_USER` — `root`, matching how it's deployed manually today.
- `SERVER_SSH_KEY` — a private key whose public half is in that server's `~/.ssh/authorized_keys`.

Deliberately `npm install`, not `npm ci`, on the server — `npm ci` wipes `node_modules` on every run, which would force `better-sqlite3` to recompile its native addon (the slow, failure-prone step from getting this running the first time) on every single deploy instead of just once.

## Required zupa-api-side configuration

Set these on zupa-api, in addition to this service's own `.env`:
- `WHATSAPP_AGENT_API_KEY` — same value as this service's.
- `WHATSAPP_AGENT_BASE_URL` — this service's base URL, so zupa-api's inbound webhook handler can forward messages here.

## Live log viewer

Set `LOGS_ACCESS_KEY` in `.env` (a value separate from `WHATSAPP_AGENT_API_KEY` — see why in `.env.example`), then visit `https://<this-service>/logs` — it'll prompt for the key, or append `?key=...` directly. Two auto-refreshing panels, operation logs (stdout) and error logs (stderr), reading straight from the files `ecosystem.config.js` points PM2 at (`./logs/out.log`, `./logs/error.log`). Leave `LOGS_ACCESS_KEY` unset to disable the feature entirely — unconfigured, `/logs` 404s rather than just rejecting a missing key, so it doesn't advertise itself.

This reads PM2's own log files, so it only shows anything once PM2 is actually running the app with `ecosystem.config.js` (not `node src/index.js` directly, and not `pm2 start src/index.js` without the ecosystem file — neither of those writes to the paths this expects).

## Session storage

SQLite (`better-sqlite3`), not Postgres — see the plan doc's Workstream B section for why. `DB_PATH` **must** point at a persistent volume in any deployed environment; losing that file loses every in-flight cart and session.

## Delivery-zone resolution

Both pickup and home-delivery are now wired end-to-end:
- **Pickup**: `get_pickup_branches` → `GET /customer-requests/stores/:storeId/branches`, resolved into an order via `createBotOrder`'s existing `findActiveBranchByText`/`pickupDeliveryTypeId` logic — the same mechanism `slack-bot/order/new` already uses in production.
- **Delivery**: `search_delivery_zones` → `GET /auth/stores/:storeId`'s `delivery_types`, classified with the exact same name-pattern rules the Slack bot uses (`src/agent/deliveryZones.js`, mirroring Slackbot's `src/data/loader.js`) into named zones vs. Uber/Bolt on-demand tiers, surge variants excluded. The matched zone's `id` becomes `address.cityId` once an order is actually created (see "Order creation is payment-gated" below).

The zone matching itself is a simple substring/token match (`searchZones` in `deliveryZones.js`), not the Slack bot's full fuzzy/alias matcher backing its live-typeahead UI — that's a reasonable v1 given the LLM confirms the matched zone name with the customer before proceeding either way. Worth revisiting if the CSR chat-export review shows customers describing areas in ways this simple match handles poorly.

## Order status lookups

`get_order_status` answers "where's my order"/"status of my last order" directly instead of escalating every time — `GET /customer-requests/stores/:storeId/whatsapp-agent/orders?phoneNumber=...` (zupa-api, `whatsappAuth`-gated, `fetchCustomerOrderStatus` in `customer-request/util.js`) returns the customer's recent orders with status, delivery type, items, and — once dispatched — rider name/phone and ETA. It's keyed by phone number, not orderNumber, so the customer never needs to already know an order number, and the tool defaults to the number the conversation is on rather than trusting a model-supplied one. Deliberately a new route rather than reusing kitchen-api's existing `order-status-whatsapp` — that one is unauthenticated and builds its query via raw, string-interpolated SQL.

## Handoff behavior

- **Escalating to a human requires the customer's go-ahead first** — the agent asks ("this will need a human teammate, is that okay?") and only calls `escalate_to_human` once they agree, unless they already explicitly asked for a person themselves. The exception is a hard failure (an LLM turn erroring, a WhatsApp send failing, a human replying mid-turn) — those escalate immediately, with no confirmation needed, since there's nothing left for the agent to do.
- **A stale handoff auto-resumes.** `STALE_HANDOFF_HOURS` (default 12) — once a `human_handoff` session is older than this, the customer's next message flips it straight back to `ai_ordering` before the agent responds, on the reasoning that no CSR is realistically still watching the same chat that many hours later. This is a plain timestamp check (`escalatedAt` vs. now), not an LLM judgment call. A system note is posted to the transcript so a CSR reviewing it later can see why the AI picked it back up.

## Status

Workstreams A (zupa-api), B (this service), and C (zupa-crm: mode badge, take-over button, AI-reply forwarding) are all implemented and pushed. Go live in shadow mode first, per the plan.
