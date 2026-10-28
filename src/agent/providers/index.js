"use strict";

const config = require("../../config");

// AI_PROVIDER switch, same convention as the Slack bot's ai-client.js:
// "openai" (the system-wide default everywhere else) or "claude"/"anthropic"
// as the backup. Each adapter exposes the same { runTurn, toolResultRow,
// buildApiMessages } shape so agent/orchestrator.js never needs to know
// which one is active.
const provider =
  config.aiProvider === "claude" || config.aiProvider === "anthropic"
    ? require("./anthropic")
    : require("./openai");

module.exports = provider;
