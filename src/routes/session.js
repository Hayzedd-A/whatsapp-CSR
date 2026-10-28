"use strict";

const express = require("express");
const sessions = require("../db/sessions");

const router = express.Router();

// Called by zupa-api (forwarded from zupa-crm) when a rep clicks "take
// over" on a conversation — stops the agent from auto-replying, regardless
// of whether it had escalated on its own.
router.post("/pause", (req, res) => {
  const { phoneNumber, reason } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ message: "phoneNumber is required" });
  }

  sessions.updateSession(phoneNumber, {
    mode: "human_handoff",
    escalatedAt: Date.now(),
    escalationReason: reason || "rep_takeover",
  });

  console.log(`[session] ${phoneNumber} paused (${reason || "rep_takeover"})`);
  return res.status(200).json({ success: true });
});

// Lets a rep hand the conversation back to the agent from zupa-crm.
router.post("/resume", (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ message: "phoneNumber is required" });
  }

  sessions.updateSession(phoneNumber, {
    mode: "ai_ordering",
    escalatedAt: null,
    escalationReason: null,
  });

  console.log(`[session] ${phoneNumber} resumed to ai_ordering`);
  return res.status(200).json({ success: true });
});

module.exports = router;
