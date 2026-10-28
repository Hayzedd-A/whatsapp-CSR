"use strict";

const config = require("../../config");

let _client = null;
function getClient() {
  if (!_client) {
    if (!config.openaiApiKey) throw new Error("OPENAI_API_KEY not set");
    const { OpenAI } = require("openai");
    _client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return _client;
}

// Anthropic-shaped { name, description, input_schema } -> OpenAI's
// function-tool shape. The tool definitions in agent/tools.js are written
// once, in Anthropic's format, and each provider adapts them.
function toOpenAITools(toolDefinitions) {
  return toolDefinitions.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

// Stored rows are one of:
//  - { role: "user", content: <string> }
//  - { role: "assistant", content: <raw OpenAI assistant message object> }
//  - { role: "tool_batch", content: [<raw OpenAI tool-role message>, ...] }
// Only "tool_batch" needs expanding — the Chat Completions API wants each
// tool result as its own top-level message, not nested under one entry.
function buildApiMessages(rows) {
  const out = [];
  for (const row of rows) {
    if (row.role === "tool_batch") {
      out.push(...row.content); // each entry is already a full { role: "tool", ... } message
    } else if (row.role === "assistant") {
      out.push(row.content); // the raw OpenAI assistant message, already { role, content, tool_calls? }
    } else {
      out.push({ role: row.role, content: row.content }); // plain "user" turn
    }
  }
  return out;
}

async function runTurn({ systemPrompt, toolDefinitions, messages }) {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: config.openaiModel,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    tools: toOpenAITools(toolDefinitions),
  });

  const message = completion.choices[0].message; // { role, content, tool_calls? }
  const toolCalls = (message.tool_calls || []).map((tc) => ({
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments || "{}"),
  }));

  return {
    assistantRow: { role: "assistant", content: message },
    toolCalls,
    text: message.content || null,
    hasToolCalls: toolCalls.length > 0,
  };
}

function toolResultRow(results) {
  return {
    role: "tool_batch",
    content: results.map((r) => ({
      role: "tool",
      tool_call_id: r.id,
      content: typeof r.output === "string" ? r.output : JSON.stringify(r.output),
    })),
  };
}

module.exports = { runTurn, toolResultRow, buildApiMessages };
