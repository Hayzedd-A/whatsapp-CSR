"use strict";

const db = require("./index");
const config = require("../config");

const MAX_LOCAL_MESSAGES = 40; // bounds prompt size/cost; recent context is what matters for ordering

// Each stored message row is tagged with the provider that wrote it, so
// switching AI_PROVIDER never replays one provider's wire format (e.g.
// Anthropic's content-block arrays) through the other adapter — which
// throws, since e.g. OpenAI expects each message to be a plain object, not
// an array. A switch just means that conversation's local context starts
// fresh under the new provider instead of crashing on its next turn.
function activeProvider() {
  const p = config.aiProvider;
  return p === "claude" || p === "anthropic" ? "anthropic" : "openai";
}

function parseSession(row) {
  if (!row) return null;
  return {
    ...row,
    cart: JSON.parse(row.cart || "[]"),
    deliveryAddress: row.deliveryAddress ? JSON.parse(row.deliveryAddress) : null,
    recipient: row.recipient ? JSON.parse(row.recipient) : null,
    pendingOrder: row.pendingOrder ? JSON.parse(row.pendingOrder) : null,
    resumeOfferDeclined: !!row.resumeOfferDeclined,
  };
}

function getSession(phoneNumber) {
  const row = db
    .prepare("SELECT * FROM sessions WHERE phoneNumber = ?")
    .get(phoneNumber);
  return parseSession(row);
}

function getOrCreateSession(phoneNumber) {
  const existing = getSession(phoneNumber);
  if (existing) return existing;

  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions (phoneNumber, mode, cart, paymentStatus, lastMessageAt, createdAt, updatedAt)
     VALUES (?, 'ai_ordering', '[]', 'pending', ?, ?, ?)`,
  ).run(phoneNumber, now, now, now);

  return getSession(phoneNumber);
}

// `patch` may include: mode, cart (array), deliveryAddress (object|null),
// recipient (object|null), pendingOrder (object|null), orderId, orderNumber,
// clientReference, paymentStatus, escalatedAt (ms epoch|null), escalationReason,
// resumeOfferedAt (ms epoch|null), resumeOfferDeclined (boolean).
function updateSession(phoneNumber, patch) {
  const current = getOrCreateSession(phoneNumber);
  const next = { ...current, ...patch };

  // Any explicit mode change (a fresh escalation, or a resume for any
  // reason — customer confirmed, stale-handoff auto-resume, a rep manually
  // resuming) clears the resume-offer state, so a new handoff episode
  // always starts with a fresh offer cycle rather than inheriting a stale
  // "already declined" from a previous one. The one path that intentionally
  // sets these fields WITHOUT changing mode (handleHandoffMessage, making or
  // recording the outcome of an offer) is unaffected, since it never
  // includes `mode` in its patch.
  if ("mode" in patch && !("resumeOfferedAt" in patch) && !("resumeOfferDeclined" in patch)) {
    next.resumeOfferedAt = null;
    next.resumeOfferDeclined = false;
  }

  db.prepare(
    `UPDATE sessions SET
       mode = ?, cart = ?, deliveryAddress = ?, recipient = ?, pendingOrder = ?,
       orderId = ?, orderNumber = ?, clientReference = ?, paymentStatus = ?,
       escalatedAt = ?, escalationReason = ?, resumeOfferedAt = ?, resumeOfferDeclined = ?,
       lastMessageAt = ?, updatedAt = ?
     WHERE phoneNumber = ?`,
  ).run(
    next.mode,
    JSON.stringify(next.cart || []),
    next.deliveryAddress ? JSON.stringify(next.deliveryAddress) : null,
    next.recipient ? JSON.stringify(next.recipient) : null,
    next.pendingOrder ? JSON.stringify(next.pendingOrder) : null,
    next.orderId || null,
    next.orderNumber || null,
    next.clientReference || null,
    next.paymentStatus,
    next.escalatedAt || null,
    next.escalationReason || null,
    next.resumeOfferedAt || null,
    next.resumeOfferDeclined ? 1 : 0,
    Date.now(),
    Date.now(),
    phoneNumber,
  );

  return getSession(phoneNumber);
}

function touchLastMessageAt(phoneNumber) {
  db.prepare("UPDATE sessions SET lastMessageAt = ? WHERE phoneNumber = ?").run(
    Date.now(),
    phoneNumber,
  );
}

// `content` is whatever shape the orchestrator wants to replay back to
// Claude later — for a plain customer/agent text turn, a string; for an
// assistant turn with tool calls, the raw Anthropic content block array.
function appendMessage(phoneNumber, role, content) {
  const provider = activeProvider();
  db.prepare(
    "INSERT INTO messages (phoneNumber, role, content, provider, createdAt) VALUES (?, ?, ?, ?, ?)",
  ).run(phoneNumber, role, JSON.stringify(content), provider, Date.now());

  // Prune oldest rows beyond the cap so prompt size/cost doesn't grow
  // unbounded over a long-lived conversation. Scoped to this provider so a
  // burst of messages under one provider can't evict the other's history.
  db.prepare(
    `DELETE FROM messages WHERE phoneNumber = ? AND provider = ? AND id NOT IN (
       SELECT id FROM messages WHERE phoneNumber = ? AND provider = ? ORDER BY id DESC LIMIT ?
     )`,
  ).run(phoneNumber, provider, phoneNumber, provider, MAX_LOCAL_MESSAGES);
}

function getRecentMessages(phoneNumber) {
  const rows = db
    .prepare(
      "SELECT role, content FROM messages WHERE phoneNumber = ? AND provider = ? ORDER BY id ASC",
    )
    .all(phoneNumber, activeProvider());
  return rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
}

module.exports = {
  getSession,
  getOrCreateSession,
  updateSession,
  touchLastMessageAt,
  appendMessage,
  getRecentMessages,
};
