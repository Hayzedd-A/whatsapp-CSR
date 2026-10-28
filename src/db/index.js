"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const config = require("../config");

// SQLite, not Postgres — this service runs as a single Node process (no
// infrastructure to provision, matches the Slack bot's own use of
// better-sqlite3 for per-conversation draft state). The one hard
// requirement: DB_PATH must point at a persistent volume/disk in any
// deployed environment, or session/cart state is lost on redeploy.
const resolvedPath = path.resolve(config.dbPath);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const db = new Database(resolvedPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    phoneNumber TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'ai_ordering',
    cart TEXT NOT NULL DEFAULT '[]',
    deliveryAddress TEXT,
    recipient TEXT,
    pendingOrder TEXT,
    orderId TEXT,
    orderNumber TEXT,
    clientReference TEXT,
    paymentStatus TEXT NOT NULL DEFAULT 'pending',
    escalatedAt INTEGER,
    escalationReason TEXT,
    lastMessageAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );

  -- Local message history, used only to drive the LLM prompt (recent
  -- context + tool-call continuity). This is NOT the canonical transcript —
  -- that's zupa-api's whatsapp_conversation_messages table, which both this
  -- service and zupa-crm write to and which the pre-send safety check reads
  -- from. This table exists purely so the agent doesn't need to re-fetch and
  -- replay the full transcript from zupa-api on every single turn.
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phoneNumber TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    provider TEXT,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_phone_created
    ON messages (phoneNumber, createdAt);
`);

// Additive migration for databases created before `pendingOrder` existed —
// CREATE TABLE IF NOT EXISTS above is a no-op against an existing table, so
// this covers already-deployed DB files.
try {
  db.exec(`ALTER TABLE sessions ADD COLUMN pendingOrder TEXT;`);
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// Additive migration for messages rows written before provider-tagging
// existed (see db/sessions.js) — left NULL on purpose, not backfilled: a row
// with no provider tag simply won't match either provider's history query,
// so old mixed-format rows are safely ignored instead of being replayed
// through the wrong provider's adapter.
try {
  db.exec(`ALTER TABLE messages ADD COLUMN provider TEXT;`);
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

module.exports = db;
