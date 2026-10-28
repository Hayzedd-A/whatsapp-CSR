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

// One-shot structured-output classification, decoupled from the stored
// tool-calling conversation history (used for e.g. the resume-offer
// decision in agent/orchestrator.js) — same pattern as the Slack bot's
// ai-client.js claudeStructuredCompletion.
async function classify({ systemPrompt, userMessage, schemaName, schema }) {
  const client = getClient();
  const message = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: 256,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    tools: [
      {
        name: schemaName,
        description: `Return structured data matching the ${schemaName} schema.`,
        input_schema: schema,
      },
    ],
    tool_choice: { type: "tool", name: schemaName },
  });

  const toolUse = message.content.find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error(`${schemaName} classification did not return a tool_use block`);
  return toolUse.input;
}

module.exports = { runTurn, toolResultRow, buildApiMessages, classify };
