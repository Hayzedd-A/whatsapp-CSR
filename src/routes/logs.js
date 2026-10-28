"use strict";

const express = require("express");
const config = require("../config");
const { tailFile } = require("../lib/tailLog");

const router = express.Router();

function hasValidKey(req) {
  if (!config.logsAccessKey) return false; // feature disabled unless explicitly configured
  const headerKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const queryKey = req.query.key;
  return headerKey === config.logsAccessKey || queryKey === config.logsAccessKey;
}

// GET /logs/raw?stream=out|error&lines=200&key=...
// JSON API the page's own JS polls — also usable directly (curl, another
// tool) independent of the HTML viewer.
router.get("/raw", (req, res) => {
  if (!config.logsAccessKey) return res.status(404).end();
  if (!hasValidKey(req)) return res.status(401).json({ message: "Not authenticated" });

  const stream = req.query.stream === "error" ? "error" : "out";
  const lines = Math.min(parseInt(req.query.lines, 10) || 200, 1000);
  const filePath = stream === "error" ? config.errorLogPath : config.outLogPath;

  return res.json({ stream, lines: tailFile(filePath, lines) });
});

// GET /logs?key=... — a small self-contained HTML page, no build step/
// framework, since this is an internal ops tool served by the app itself.
router.get("/", (req, res) => {
  if (!config.logsAccessKey) return res.status(404).end();

  if (!hasValidKey(req)) {
    return res.status(401).send(`<!doctype html>
<html><head><title>Logs — access key required</title></head>
<body style="font-family: system-ui, sans-serif; background:#111; color:#eee; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
  <form onsubmit="window.location.href='/logs?key='+encodeURIComponent(document.getElementById('k').value); return false;" style="text-align:center;">
    <p>Enter the logs access key</p>
    <input id="k" type="password" autofocus style="padding:8px; font-size:14px;" />
    <button style="padding:8px 16px;">View logs</button>
  </form>
</body></html>`);
  }

  const key = req.query.key || "";
  return res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>whatsapp-agent — logs</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; font-family: ui-monospace, "SF Mono", Consolas, monospace; background: #0d1117; color: #c9d1d9; }
    header { padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 14px; font-weight: 600; margin: 0; color: #8b949e; }
    header .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
    main { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: #30363d; height: calc(100vh - 41px); }
    section { background: #0d1117; display: flex; flex-direction: column; min-width: 0; }
    section h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 12px; margin: 0; border-bottom: 1px solid #21262d; color: #8b949e; position: sticky; top: 0; background: #0d1117; }
    section.errors h2 { color: #f85149; }
    pre { flex: 1; overflow-y: auto; margin: 0; padding: 10px 12px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; }
    .line { display: block; }
    .errors pre .line { color: #ffa198; }
    footer { position: fixed; bottom: 8px; right: 12px; font-size: 11px; color: #484f58; }
  </style>
</head>
<body>
  <header><span class="dot"></span><h1>whatsapp-agent — live logs (refreshes every 4s)</h1></header>
  <main>
    <section class="operations"><h2>Operation logs</h2><pre id="out">Loading…</pre></section>
    <section class="errors"><h2>Error logs</h2><pre id="error">Loading…</pre></section>
  </main>
  <footer id="updated"></footer>
  <script>
    const key = ${JSON.stringify(key)};
    async function load(stream, elId) {
      const el = document.getElementById(elId);
      const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
      try {
        const res = await fetch('/logs/raw?stream=' + stream + '&lines=300&key=' + encodeURIComponent(key));
        if (!res.ok) { el.textContent = 'Error loading logs (' + res.status + ')'; return; }
        const data = await res.json();
        el.textContent = data.lines.length ? data.lines.join('\\n') : '(empty)';
        if (wasAtBottom) el.scrollTop = el.scrollHeight;
      } catch (e) {
        el.textContent = 'Failed to reach the server: ' + e.message;
      }
    }
    function tick() {
      load('out', 'out');
      load('error', 'error');
      document.getElementById('updated').textContent = 'Last updated ' + new Date().toLocaleTimeString();
    }
    tick();
    setInterval(tick, 4000);
  </script>
</body>
</html>`);
});

module.exports = router;
