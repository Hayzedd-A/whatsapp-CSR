"use strict";

const axios = require("axios");
const config = require("../src/config");

// Every call here carries the same bearer token — the WHATSAPP_AGENT_API_KEY
// shared secret, checked by the `whatsappAuth`/`slackOrWhatsappAuth` guards
// added on the zupa-api side for each of these routes.
const client = axios.create({
  baseURL: config.zupaApiBaseUrl,
  timeout: 10000,
  headers: { Authorization: `Bearer ${config.whatsappAgentApiKey}` },
});

// GET /customer-requests/stores/:storeId/whatsapp-agent/products — sibling of
// the customer-facing products route in zupa-api, both backed by the same
// fetchStoreProducts() (customer-request/util.js) on that side.
async function fetchMenu({ includeSpecial, branchId } = {}) {
  const { data } = await client.get(
    `/customer-requests/stores/${config.zupaStoreId}/whatsapp-agent/products`,
    { params: { includeSpecial, branchId } },
  );
  return data.data;
}

// POST /customer-requests/stores/whatsapp-agent/order/new — sibling of
// slack-bot/order/new, both backed by the same createBotOrder() on that
// side. `clientReference` makes retries safe: calling this twice with the
// same reference returns the already-created order instead of a duplicate.
async function createOrder({ customer, order, address, recipient, clientReference }) {
  const { data } = await client.post(
    "/customer-requests/stores/whatsapp-agent/order/new",
    { customer, order, address, recipient, clientReference },
  );
  return data;
}

// POST /payment/order/verify-payment — the existing Squad bank-transfer
// matching flow (by customer/recipient name + total, with a tolerance and
// a 24h window), exactly as the Slack bot already uses it. No new
// payment-link code — customers transfer to the published account and this
// polls for a matching transfer.
async function verifyPayment({ customerName, recipientName, totalPrice, deliveryPrice, couponCode }) {
  try {
    const { data } = await client.post("/payment/order/verify-payment", {
      customerName,
      recipientName,
      totalPrice,
      deliveryPrice,
      couponCode,
    });
    return data; // { matched: true, transactionRef, ... }
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return { matched: false };
    }
    throw error;
  }
}

// POST /kitchen-api/send-free-form-message — the same send path a human
// rep's CRM session uses; `sender: "ai-agent"` is what lets zupa-crm later
// tell AI-authored replies apart from staff ones in the shared transcript.
async function sendMessage({ to, orderNumber, message, media, replyMessageId, messageId }) {
  const { data } = await client.post("/kitchen-api/send-free-form-message", {
    to,
    // "" not null — zupa-api resolves `to` from the order's customer when an
    // orderNumber is given, so a null/falsy value must never reach it as a
    // literal null (Sequelize matches that against any order with a null
    // orderNumber and can silently redirect `to` to an unrelated customer).
    // zupa-api is now fixed to guard against this regardless, but this
    // stays explicit here too.
    orderNumber: orderNumber || "",
    isTemplate: false,
    message,
    media: media || null,
    replyMessageId: replyMessageId || null,
    messageId,
    sender: "ai-agent",
  });
  return data;
}

// GET /auth/whatsapp/conversations/:phoneNumber/messages — the pre-send
// safety check: has a human (sender starting with "staff:") written into
// this conversation since the agent's own last turn?
async function getRecentConversationMessages(phoneNumber, limit = 10) {
  const { data } = await client.get(
    `/auth/whatsapp/conversations/${phoneNumber}/messages`,
    { params: { limit } },
  );
  return data.messages;
}

// POST /auth/whatsapp/conversations/:phoneNumber/notes — a visible,
// in-context transcript note (e.g. an escalation reason) that is logged for
// zupa-crm to see but never sent to the customer as an actual WhatsApp
// message, unlike sendMessage() above.
async function postSystemNote(phoneNumber, body, { orderNumber, mode } = {}) {
  await client.post(`/auth/whatsapp/conversations/${phoneNumber}/notes`, {
    body,
    orderNumber,
    mode,
  });
}

// GET /customer-requests/stores/:storeId/branches — already unauthenticated/
// public on the zupa-api side (no change needed there), used to resolve a
// pickup branch by name.
async function fetchBranches() {
  const { data } = await client.get(
    `/customer-requests/stores/${config.zupaStoreId}/branches`,
  );
  return data;
}

// GET /auth/stores/:storeId — public, already filters to isActive delivery
// types server-side. Returns the `delivery_types` array that mixes named
// delivery zones, Uber/Bolt tiers, and pickup-related rows together,
// distinguished only by a name pattern — see agent/deliveryZones.js.
async function fetchDeliveryTypes() {
  const { data } = await client.get(`/auth/stores/${config.zupaStoreId}`);
  return data.delivery_types || [];
}

module.exports = {
  fetchMenu,
  createOrder,
  verifyPayment,
  sendMessage,
  getRecentConversationMessages,
  postSystemNote,
  fetchBranches,
  fetchDeliveryTypes,
};
