"use strict";

const db = require("./index");

const MAX_LOCAL_MESSAGES = 40; // bounds prompt size/cost; recent context is what matters for ordering

function parseSession(row) {
  if (!row) return null;
  return {
    ...row,
    cart: JSON.parse(row.cart || "[]"),
    deliveryAddress: row.deliveryAddress ? JSON.parse(row.deliveryAddress) : null,
    recipient: row.recipient ? JSON.parse(row.recipient) : null,
    pendingOrder: row.pendingOrder ? JSON.parse(row.pendingOrder) : null,
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
// clientReference, paymentStatus, escalatedAt (ms epoch|null), escalationReason.
function updateSession(phoneNumber, patch) {
  const current = getOrCreateSession(phoneNumber);
  const next = { ...current, ...patch };

  db.prepare(
    `UPDATE sessions SET
       mode = ?, cart = ?, deliveryAddress = ?, recipient = ?, pendingOrder = ?,
       orderId = ?, orderNumber = ?, clientReference = ?, paymentStatus = ?,
       escalatedAt = ?, escalationReason = ?, lastMessageAt = ?, updatedAt = ?
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
  db.prepare(
    "INSERT INTO messages (phoneNumber, role, content, createdAt) VALUES (?, ?, ?, ?)",
  ).run(phoneNumber, role, JSON.stringify(content), Date.now());

  // Prune oldest rows beyond the cap so prompt size/cost doesn't grow
  // unbounded over a long-lived conversation.
  db.prepare(
    `DELETE FROM messages WHERE phoneNumber = ? AND id NOT IN (
       SELECT id FROM messages WHERE phoneNumber = ? ORDER BY id DESC LIMIT ?
     )`,
  ).run(phoneNumber, phoneNumber, MAX_LOCAL_MESSAGES);
}

function getRecentMessages(phoneNumber) {
  const rows = db
    .prepare(
      "SELECT role, content FROM messages WHERE phoneNumber = ? ORDER BY id ASC",
    )
    .all(phoneNumber);
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
