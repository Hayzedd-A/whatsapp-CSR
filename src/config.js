"use strict";

require("dotenv").config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

module.exports = {
  port: parseInt(process.env.PORT, 10) || 4100,

  whatsappAgentApiKey: required("WHATSAPP_AGENT_API_KEY"),
  zupaApiBaseUrl: required("ZUPA_API_BASE_URL"),
  zupaStoreId: required("ZUPA_STORE_ID"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",

  dbPath: process.env.DB_PATH || "./data/agent.db",

  payment: {
    bankName: process.env.PAYMENT_BANK_NAME || "",
    accountNumber: process.env.PAYMENT_ACCOUNT_NUMBER || "",
    accountName: process.env.PAYMENT_ACCOUNT_NAME || "",
  },
};
