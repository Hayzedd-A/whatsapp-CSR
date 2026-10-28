"use strict";

const express = require("express");
const config = require("./config");
require("./db"); // opens the SQLite DB and ensures schema exists, before anything else touches it

const { verifyZupaApiCaller } = require("./middleware/auth");
const webhookRoutes = require("./routes/webhook");
const sessionRoutes = require("./routes/session");
const logsRoutes = require("./routes/logs");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.status(200).json({ status: "ok" }));

app.use("/webhook", verifyZupaApiCaller, webhookRoutes);
app.use("/session", verifyZupaApiCaller, sessionRoutes);
// Human-facing, not zupa-api-facing — its own key check lives inside
// routes/logs.js (LOGS_ACCESS_KEY), deliberately not verifyZupaApiCaller.
app.use("/logs", logsRoutes);

app.listen(config.port, () => {
  console.log(`zupa-whatsapp-ai-agent listening on port ${config.port}`);
});
