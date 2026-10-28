"use strict";

const config = require("../../config");

let _client = null;
function getClient() {
  if (!_client) {
    if (!config.anthropicApiKey) throw new Error("ANTHROPIC_API_KEY not set");
    const Anthropic = require("@anthropic-ai/sdk");
    _client = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return _client;
}

// Stored rows already match Anthropic's wire format 1:1 (assistant rows hold
// the raw content-block array, tool-result rows hold a single "user" message
// wrapping an array of tool_result blocks) — nothing to expand here, unlike
// the OpenAI adapter.
function buildApiMessages(rows) {
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

async function runTurn({ systemPrompt, toolDefinitions, messages }) {
  const client = getClient();
  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 1024,
    system: systemPrompt,
    tools: toolDefinitions,
    messages,
  });

  const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
  const textBlock = response.content.find((b) => b.type === "text");

  return {
    assistantRow: { role: "assistant", content: response.content },
    toolCalls: toolUseBlocks.map((b) => ({ id: b.id, name: b.name, input: b.input })),
    text: textBlock ? textBlock.text : null,
    hasToolCalls: response.stop_reason === "tool_use",
  };
}

function toolResultRow(results) {
  return {
    role: "user",
    content: results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.id,
      content: typeof r.output === "string" ? r.output : JSON.stringify(r.output),
    })),
  };
}

module.exports = { runTurn, toolResultRow, buildApiMessages };
