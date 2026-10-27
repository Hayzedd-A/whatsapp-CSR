"use strict";

const express = require("express");
const sessions = require("../db/sessions");
const { handleInboundMessage } = require("../agent/orchestrator");

const router = express.Router();

// Called from zupa-api's inbound WhatsApp webhook handler (one non-blocking
// call added at the point it already calls sendWhatsappFeedbackToTeam).
// Must respond fast — the actual LLM turn runs after responding, so this
// call is never on zupa-api's webhook response's critical path.
router.post("/inbound", (req, res) => {
  const { from, text, mediaUrl, mediaType, waMessageId } = req.body;
  if (!from) {
    return res.status(400).json({ message: "from is required" });
  }

  const session = sessions.getOrCreateSession(from);
  res.status(200).json({ handled: session.mode !== "human_handoff", mode: session.mode });

  if (session.mode === "human_handoff") return;

  handleInboundMessage(from, { text, mediaUrl, mediaType, waMessageId }).catch((error) => {
    console.error(`[webhook] unhandled error for ${from}:`, error);
  });
});

module.exports = router;
