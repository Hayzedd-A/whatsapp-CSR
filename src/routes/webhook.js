"use strict";

const express = require("express");
const config = require("../config");
const sessions = require("../db/sessions");
const zupaApi = require("../zupaApiClient");
const { handleInboundMessage, handleHandoffMessage } = require("../agent/orchestrator");

const router = express.Router();

const STALE_HANDOFF_MS = config.staleHandoffHours * 60 * 60 * 1000;

// Called from zupa-api's inbound WhatsApp webhook handler (one non-blocking
// call added at the point it already calls sendWhatsappFeedbackToTeam).
// Must respond fast — the actual LLM turn runs after responding, so this
// call is never on zupa-api's webhook response's critical path.
router.post("/inbound", (req, res) => {
  const { from, text, mediaUrl, mediaType, waMessageId } = req.body;
  if (!from) {
    return res.status(400).json({ message: "from is required" });
  }

  let session = sessions.getOrCreateSession(from);

  if (session.mode === "human_handoff") {
    // escalatedAt should always be set alongside human_handoff (every code
    // path that sets the mode sets this too) — missing it is treated as
    // "stale" rather than "never expires", since getting unstuck is the
    // safer failure mode here than a conversation stuck forever.
    const handoffAgeMs = session.escalatedAt ? Date.now() - session.escalatedAt : Infinity;
    if (handoffAgeMs > STALE_HANDOFF_MS) {
      console.log(
        `[webhook] ${from} handoff stale (${(handoffAgeMs / 3600000).toFixed(1)}h > ${config.staleHandoffHours}h) — auto-resuming to ai_ordering`,
      );
      session = sessions.updateSession(from, {
        mode: "ai_ordering",
        escalatedAt: null,
        escalationReason: null,
      });
      zupaApi
        .postSystemNote(from, `AI auto-resumed — no CSR activity for over ${config.staleHandoffHours}h`, { mode: "ai_ordering" })
        .catch((e) => console.error(`[webhook] failed to post auto-resume system note for ${from}:`, e.message));
    }
  }

  res.status(200).json({ handled: session.mode !== "human_handoff", mode: session.mode });

  console.log(
    `[webhook] inbound from ${from} (mode=${session.mode}, type=${mediaType || (text ? "text" : "unknown")})`,
  );

  if (session.mode === "human_handoff") {
    console.log(`[webhook] ${from} is in human_handoff — checking resume-offer flow`);
    handleHandoffMessage(from, { text, waMessageId }).catch((error) => {
      console.error(`[webhook] handoff-resume check failed for ${from}:`, error.message);
    });
    return;
  }

  handleInboundMessage(from, { text, mediaUrl, mediaType, waMessageId }).catch((error) => {
    console.error(`[webhook] unhandled error for ${from}:`, error);
  });
});

module.exports = router;
