"use strict";

const sessions = require("../db/sessions");
const zupaApi = require("../zupaApiClient");
const { tools } = require("./tools");
const { buildSystemPrompt } = require("./prompt");
const provider = require("./providers");

const toolDefinitions = Object.values(tools).map((t) => t.definition);

const MAX_TOOL_ROUNDS = 8; // guards against a runaway tool-call loop

// zupa-crm's rep-send path tags outbound messages with the rep's actual
// name (e.g. "Jane Doe" — see its whatsapp-send function), not a fixed
// "staff:<id>" prefix, so "human" here means "anything that isn't one of
// our own known senders."
const KNOWN_NON_HUMAN_SENDERS = new Set(["ai-agent", "customer", "system"]);

// Shared by the pre-send safety check (has a human replied since I started
// composing this turn's reply?) and the resume-offer flow (has a human
// been active recently, so a proactive offer shouldn't interrupt them?).
async function hasHumanRepliedSince(phoneNumber, sinceMs, limit = 5) {
  const recent = await zupaApi.getRecentConversationMessages(phoneNumber, limit);
  return recent.some(
    (m) =>
      m.direction === "outbound" &&
      m.sender &&
      !KNOWN_NON_HUMAN_SENDERS.has(m.sender) &&
      new Date(m.createdAt).getTime() > sinceMs,
  );
}

// zupa-api forwards this on to zupa-crm (its own, separate database) when
// `mode` is set — without it, a CSR gets no notice at all that the AI handed
// off or auto-resumed, and the "AI handling" badge there only ever moves via
// a rep's own manual take-over click. Not called for the mid-turn-human-reply
// handoff below: zupa-crm already knows in that case, since the rep's own
// send already flipped handled_by (zupa-crm's whatsapp-send function).
async function notifyHandoffChange(phoneNumber, mode, reason) {
  try {
    const orderNumber = sessions.getSession(phoneNumber)?.orderNumber;
    await zupaApi.postSystemNote(phoneNumber, reason, { orderNumber, mode });
  } catch (e) {
    console.error(`[agent] failed to post ${mode} system note for ${phoneNumber}:`, e.message);
  }
}

// The side effect of "say this to the customer" — defaults to the real
// WhatsApp send. A different one gets passed in from routes/testChat.js so
// the exact same turn/escalation/handoff logic below can be exercised from
// the browser-based test UI without ever touching the Graph API (and
// without needing a real phone number) — it just captures the text instead.
const defaultDeliver = async (phoneNumber, message, { waMessageId, orderNumber } = {}) => {
  await zupaApi.sendMessage({
    to: phoneNumber,
    orderNumber,
    message,
    replyMessageId: waMessageId,
    messageId: `agent-${phoneNumber}-${Date.now()}`,
  });
};

const RESUME_OFFER_TEXT =
  "Looks like your query's been fully handled — would you like me to help you with anything else, like placing an order?";
// Don't offer if a human has been active this recently — a proactive
// message mid-conversation with a CSR is exactly the collision this is
// meant to avoid, not just a composition-window race like the check above.
const OFFER_SAFETY_WINDOW_MS = 5 * 60 * 1000;
const HANDOFF_CONTEXT_MESSAGES = 8; // transcript depth given to the offer-decision classifier

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
async function handleInboundMessage(phoneNumber, { text, mediaUrl, mediaType, waMessageId, deliver = defaultDeliver }) {
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
    await notifyHandoffChange(phoneNumber, "human_handoff", `AI error, handed off — ${error.message}`);
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
    if (await hasHumanRepliedSince(phoneNumber, turnStartedAt)) {
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
    await deliver(phoneNumber, replyText, { waMessageId, orderNumber: latestSession.orderNumber });
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
    await notifyHandoffChange(phoneNumber, "human_handoff", `AI reply failed to send, handed off — ${error.message}`);
  }
}

// Called from the webhook route for a customer message that arrives while
// the conversation is in human_handoff (and not stale enough for the
// webhook's own timestamp-based auto-resume to have already taken it).
// Two jobs, mutually exclusive per message:
//  1. If we're waiting on an answer to an offer we just made
//     (session.resumeOfferedAt set), interpret this message as that answer.
//  2. Otherwise, if we haven't already asked once this handoff episode
//     (session.resumeOfferDeclined), decide via a narrow yes/no
//     classification — not a vague confidence score — whether this message
//     looks like a fresh, self-contained request unrelated to whatever the
//     human was handling, and if so, offer to resume (never silently).
async function handleHandoffMessage(phoneNumber, { text, waMessageId, deliver = defaultDeliver }) {
  const session = sessions.getSession(phoneNumber);
  if (!session || session.mode !== "human_handoff") return; // overtaken by something else already

  if (!text) return; // media-only messages aren't worth a classification call here

  if (session.resumeOfferedAt) {
    let answer = "unclear";
    try {
      const result = await provider.classify({
        systemPrompt: `A WhatsApp AI ordering assistant for Gourmet Twist asked a customer: "${RESUME_OFFER_TEXT}". Classify the customer's reply to that question.`,
        userMessage: text,
        schemaName: "resume_offer_reply",
        schema: {
          type: "object",
          properties: { answer: { type: "string", enum: ["yes", "no", "unclear"] } },
          required: ["answer"],
        },
      });
      answer = result.answer;
    } catch (error) {
      console.error(`[agent] resume-offer reply classification failed for ${phoneNumber}:`, error.message);
    }
    console.log(`[agent] ${phoneNumber} resume-offer reply classified as "${answer}"`);

    if (answer === "yes") {
      sessions.updateSession(phoneNumber, { mode: "ai_ordering" }); // also clears resumeOfferedAt/Declined
      await notifyHandoffChange(phoneNumber, "ai_ordering", "Customer confirmed — AI resumed");
      await handleInboundMessage(phoneNumber, { text, waMessageId, deliver });
    } else {
      // "no" or "unclear" — stop asking for the rest of this handoff
      // episode (a fresh escalation later gets its own fresh offer cycle).
      sessions.updateSession(phoneNumber, { resumeOfferedAt: null, resumeOfferDeclined: true });
    }
    return;
  }

  if (session.resumeOfferDeclined) return; // already asked once this episode

  let shouldOffer = false;
  try {
    const recent = await zupaApi.getRecentConversationMessages(phoneNumber, HANDOFF_CONTEXT_MESSAGES);
    const transcript = recent
      .map((m) => `${m.direction === "inbound" ? "Customer" : m.sender || "Staff"}: ${m.body || "[media]"}`)
      .join("\n");
    const result = await provider.classify({
      systemPrompt:
        "You help an AI ordering assistant decide whether to offer to resume helping a WhatsApp customer whose conversation is currently with a human teammate. Given the recent conversation and the customer's newest message, decide if the newest message looks like a fresh, self-contained request the AI could handle alone (placing a new order, a menu question, a general question) rather than a continuation of whatever needed a human (a complaint, refund, modifying/cancelling an order, anything still unresolved). Be conservative: if there's any sign the human conversation is still ongoing or unresolved, or it's ambiguous, say no.",
      userMessage: `Recent conversation:\n${transcript}\n\nCustomer's newest message: "${text}"`,
      schemaName: "resume_offer_decision",
      schema: {
        type: "object",
        properties: { offer: { type: "boolean" }, reason: { type: "string" } },
        required: ["offer", "reason"],
      },
    });
    shouldOffer = result.offer;
    console.log(`[agent] ${phoneNumber} resume-offer decision: ${shouldOffer} (${result.reason})`);
  } catch (error) {
    console.error(`[agent] resume-offer decision classification failed for ${phoneNumber}:`, error.message);
    return; // fail closed — no classification, no unsolicited message
  }

  if (!shouldOffer) return;

  try {
    if (await hasHumanRepliedSince(phoneNumber, Date.now() - OFFER_SAFETY_WINDOW_MS)) {
      console.log(`[agent] ${phoneNumber} skipping resume offer — a human has been active recently`);
      return;
    }
  } catch (error) {
    // Unlike the normal-reply safety check, this fails CLOSED: there's no
    // reply already owed to the customer here, just a proactive message we
    // chose to send — if we can't confirm it's safe, don't send it.
    console.error(`[agent] resume-offer safety check failed for ${phoneNumber}, skipping offer:`, error.message);
    return;
  }

  try {
    await deliver(phoneNumber, RESUME_OFFER_TEXT, {});
    sessions.updateSession(phoneNumber, { resumeOfferedAt: Date.now() });
    console.log(`[agent] ${phoneNumber} sent resume offer`);
  } catch (error) {
    console.error(`[agent] failed to send resume offer to ${phoneNumber}:`, error.message);
  }
}

// Drives the exact same turn/escalation/handoff logic as the real WhatsApp
// path (same prompt, tools, provider, session state), but captures the
// reply instead of sending it — used by the /test-chat dev UI
// (routes/testChat.js) so manual testing is instant and never risks a real
// Graph API send to a placeholder id. `testId` is namespaced by the caller
// (routes/testChat.js prefixes it) so it can never collide with a real
// phone number.
async function runTestTurn(testId, text) {
  let captured = null;
  const deliver = async (phoneNumber, message) => {
    captured = message;
  };

  const session = sessions.getOrCreateSession(testId);
  if (session.mode === "human_handoff") {
    await handleHandoffMessage(testId, { text, deliver });
  } else {
    await handleInboundMessage(testId, { text, deliver });
  }

  const latest = sessions.getSession(testId);
  return {
    reply: captured,
    mode: latest.mode,
    escalationReason: latest.escalationReason,
    cart: latest.cart,
    pendingOrder: latest.pendingOrder,
    orderNumber: latest.orderNumber,
  };
}

module.exports = { handleInboundMessage, handleHandoffMessage, runTestTurn };
