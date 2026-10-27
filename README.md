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

Workstream A (zupa-api) and B (this service) are implemented. Workstream C (zupa-crm: mode badge, take-over button, extending `chat-reply-webhook` for AI-authored outbound messages) is next. Go live in shadow mode first, per the plan.
