"use strict";

const config = require("../config");

// Symmetric with zupa-api's own whatsappAuth — zupa-api calls into this
// service with the same WHATSAPP_AGENT_API_KEY it expects back when this
// service calls it, so there's exactly one shared secret for the pair.
function verifyZupaApiCaller(req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    return res.status(401).json({ message: "Not Authenticated" });
  }
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (token !== config.whatsappAgentApiKey) {
    return res.status(401).json({ message: "Not Authenticated" });
  }
  next();
}

module.exports = { verifyZupaApiCaller };
