"use strict";

const sessions = require("../db/sessions");
const zupaApi = require("../zupaApiClient");
const { tools } = require("./tools");
const { buildSystemPrompt } = require("./prompt");
const provider = require("./providers");

const toolDefinitions = Object.values(tools).map((t) => t.definition);

const MAX_TOOL_ROUNDS = 8; // guards against a runaway tool-call loop

async function runTurn(phoneNumber, userText) {
  sessions.appendMessage(phoneNumber, "user", userText);

  let finalText = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const session = sessions.getSession(phoneNumber);
    if (session.mode === "human_handoff") {
      // A tool call earlier in this same loop (or a human mid-flight) has
      // already taken this conversation out of the agent's hands.
      break;
    }

    const apiMessages = provider.buildApiMessages(sessions.getRecentMessages(phoneNumber));
    const result = await provider.runTurn({
      systemPrompt: buildSystemPrompt(),
      toolDefinitions,
      messages: apiMessages,
    });

    sessions.appendMessage(phoneNumber, result.assistantRow.role, result.assistantRow.content);

    if (result.text) finalText = result.text;

    if (!result.hasToolCalls) {
      break; // model gave its final reply for this turn
    }

    const toolResults = [];
    for (const call of result.toolCalls) {
      const tool = tools[call.name];
      let output;
      try {
        // Re-fetch so a tool reads the state left by the one that just ran
        // before it, within the same round (e.g. update_cart then
        // get_cart_summary in the same turn).
        const freshSession = sessions.getSession(phoneNumber);
        output = tool
          ? await tool.run(call.input, { phoneNumber, session: freshSession })
          : { error: `Unknown tool: ${call.name}` };
        console.log(`[agent] ${phoneNumber} tool ${call.name}(${JSON.stringify(call.input)}) -> ${JSON.stringify(output).slice(0, 300)}`);
      } catch (error) {
        console.error(`[agent] tool ${call.name} failed:`, error.message);
        output = { error: error.message || "Tool call failed" };
      }
      toolResults.push({ id: call.id, output });
    }

    const resultRow = provider.toolResultRow(toolResults);
    sessions.appendMessage(phoneNumber, resultRow.role, resultRow.content);
  }

  return finalText;
}

// Called from the webhook route, asynchronously (not awaited by the HTTP
// response back to zupa-api) — LLM latency should never hold up the
// webhook's own response.
async function handleInboundMessage(phoneNumber, { text, mediaUrl, mediaType, waMessageId }) {
  const session = sessions.getOrCreateSession(phoneNumber);
  sessions.touchLastMessageAt(phoneNumber);

  if (session.mode === "human_handoff") {
    // Not this service's turn to speak — zupa-api's existing default path
    // already logged and forwarded this to zupa-crm.
    return;
  }

  const turnStartedAt = Date.now();
  const userText = text || (mediaUrl ? `[sent a ${mediaType || "file"}]` : "[empty message]");
  console.log(`[agent] ${phoneNumber} turn started: "${userText.slice(0, 200)}"`);

  let replyText;
  try {
    replyText = await runTurn(phoneNumber, userText);
  } catch (error) {
    console.error(`[agent] turn failed for ${phoneNumber}:`, error.message);
    sessions.updateSession(phoneNumber, {
      mode: "human_handoff",
      escalatedAt: Date.now(),
      escalationReason: `Agent error: ${error.message}`,
    });
    try {
      await zupaApi.postSystemNote(phoneNumber, `AI error, handed off — ${error.message}`);
    } catch (e) {
      console.error("[agent] failed to post error system note:", e.message);
    }
    return;
  }

  if (!replyText) {
    console.log(`[agent] ${phoneNumber} turn produced no reply text (mode=${sessions.getSession(phoneNumber).mode})`);
    return; // e.g. the only thing that happened was escalation
  }

  // Defense in depth on top of the explicit take-over call: if a human
  // replied to this customer while the agent was composing its answer,
  // don't send — hand off instead of risking a double reply.
  try {
    const recent = await zupaApi.getRecentConversationMessages(phoneNumber, 5);
    // zupa-crm's rep-send path tags outbound messages with the rep's actual
    // name (e.g. "Jane Doe" — see its whatsapp-send function), not a fixed
    // "staff:<id>" prefix, so "human" here means "anything that isn't one of
    // our own known senders."
    const KNOWN_NON_HUMAN_SENDERS = new Set(["ai-agent", "customer", "system"]);
    const humanRepliedMidTurn = recent.some(
      (m) =>
        m.direction === "outbound" &&
        m.sender &&
        !KNOWN_NON_HUMAN_SENDERS.has(m.sender) &&
        new Date(m.createdAt).getTime() > turnStartedAt,
    );
    if (humanRepliedMidTurn) {
      sessions.updateSession(phoneNumber, {
        mode: "human_handoff",
        escalatedAt: Date.now(),
        escalationReason: "A staff member replied while the agent was composing a response",
      });
      return;
    }
  } catch (error) {
    // If the safety check itself fails, still send — the explicit
    // take-over path is the primary safeguard; this is a best-effort extra.
    console.error("[agent] pre-send safety check failed, sending anyway:", error.message);
  }

  const latestSession = sessions.getSession(phoneNumber);
  try {
    await zupaApi.sendMessage({
      to: phoneNumber,
      orderNumber: latestSession.orderNumber,
      message: replyText,
      replyMessageId: waMessageId,
      messageId: `agent-${phoneNumber}-${Date.now()}`,
    });
    console.log(`[agent] ${phoneNumber} replied: "${replyText.slice(0, 200)}"`);
  } catch (error) {
    // zupa-api now dispatches to WhatsApp synchronously (no queue to retry
    // later on our behalf), so a failure here is real and needs a real
    // reply — hand off rather than silently leaving the customer without
    // any answer to their last message.
    console.error(`[agent] send failed for ${phoneNumber}:`, error.message);
    sessions.updateSession(phoneNumber, {
      mode: "human_handoff",
      escalatedAt: Date.now(),
      escalationReason: `Failed to deliver AI reply: ${error.message}`,
    });
  }
}

module.exports = { handleInboundMessage };
