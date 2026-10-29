"use strict";

const express = require("express");
const config = require("../config");
const sessions = require("../db/sessions");
const { runTestTurn } = require("../agent/orchestrator");

const router = express.Router();
router.use(express.json());

function hasValidKey(req) {
  if (!config.testChatAccessKey) return false; // feature disabled unless explicitly configured
  const headerKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const queryKey = req.query.key;
  return headerKey === config.testChatAccessKey || queryKey === config.testChatAccessKey;
}

// Test sessions live in their own namespace, prefixed so they can never
// collide with — or be mistaken for — a real customer's phone number.
function testPhoneNumber(sessionId) {
  return `test-${sessionId}`;
}

// POST /test-chat/message { sessionId, text } — runs the real agent turn
// (same prompt/tools/session state as a real WhatsApp message) but never
// sends anything over WhatsApp; the reply comes straight back in the
// response instead. See agent/orchestrator.js's runTestTurn.
router.post("/message", async (req, res) => {
  if (!config.testChatAccessKey) return res.status(404).end();
  if (!hasValidKey(req)) return res.status(401).json({ message: "Not authenticated" });

  const { sessionId, text } = req.body;
  if (!sessionId || !text) {
    return res.status(400).json({ message: "sessionId and text are required" });
  }

  try {
    const result = await runTestTurn(testPhoneNumber(sessionId), text);
    return res.status(200).json(result);
  } catch (error) {
    console.error("[test-chat] turn failed:", error.message);
    return res.status(500).json({ message: error.message || "Turn failed" });
  }
});

// POST /test-chat/reset { sessionId } — wipes the test session's state and
// local message history so a tester can start a fresh conversation without
// burning a new sessionId.
router.post("/reset", (req, res) => {
  if (!config.testChatAccessKey) return res.status(404).end();
  if (!hasValidKey(req)) return res.status(401).json({ message: "Not authenticated" });

  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ message: "sessionId is required" });

  sessions.resetSession(testPhoneNumber(sessionId));
  return res.status(200).json({ success: true });
});

// GET /test-chat?key=... — a small self-contained HTML page, same pattern
// as /logs: no build step, hidden (404) unless TEST_CHAT_ACCESS_KEY is set.
router.get("/", (req, res) => {
  if (!config.testChatAccessKey) return res.status(404).end();

  if (!hasValidKey(req)) {
    return res.status(401).send(`<!doctype html>
<html><head><title>Test chat — access key required</title></head>
<body style="font-family: system-ui, sans-serif; background:#111; color:#eee; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;">
  <form onsubmit="window.location.href='/test-chat?key='+encodeURIComponent(document.getElementById('k').value); return false;" style="text-align:center;">
    <p>Enter the test-chat access key</p>
    <input id="k" type="password" autofocus style="padding:8px; font-size:14px;" />
    <button style="padding:8px 16px;">Open</button>
  </form>
</body></html>`);
  }

  const key = req.query.key || "";
  return res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>whatsapp-agent — test chat</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-monospace, "SF Mono", Consolas, monospace; background: #0d1117; color: #c9d1d9; }
    header { padding: 10px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 12px; }
    header .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
    header h1 { font-size: 14px; font-weight: 600; margin: 0; color: #8b949e; flex: 1; }
    header button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
    header button:hover { background: #30363d; }
    main { display: grid; grid-template-columns: 1fr 280px; height: calc(100vh - 41px); }
    #chat-col { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid #21262d; }
    #thread { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 75%; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
    .msg.user { align-self: flex-end; background: #1f6feb; color: #fff; }
    .msg.bot { align-self: flex-start; background: #21262d; }
    .msg.system { align-self: center; background: transparent; color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
    .msg.error { align-self: center; background: #3d1418; color: #ffa198; font-size: 12px; }
    #composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #21262d; }
    #composer input { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; padding: 10px 12px; font-size: 13px; font-family: inherit; }
    #composer input:focus { outline: none; border-color: #1f6feb; }
    #composer button { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 0 16px; font-size: 13px; cursor: pointer; }
    #composer button:hover { background: #2ea043; }
    #composer button:disabled { background: #30363d; cursor: default; }
    aside { padding: 14px; overflow-y: auto; font-size: 12px; }
    aside h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; margin: 0 0 8px; }
    aside .row { display: flex; justify-content: space-between; gap: 8px; padding: 4px 0; border-bottom: 1px solid #161b22; }
    aside .row .k { color: #8b949e; }
    aside .row .v { text-align: right; word-break: break-word; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; }
    .badge.ai_ordering { background: #0d3a1f; color: #3fb950; }
    .badge.human_handoff { background: #3d1418; color: #ffa198; }
    #cart { margin-top: 10px; }
    #cart .item { padding: 4px 0; border-bottom: 1px solid #161b22; }
    #session-id { color: #484f58; font-size: 11px; padding: 0 16px 8px; }
  </style>
</head>
<body>
  <header>
    <span class="dot"></span>
    <h1>whatsapp-agent — test chat (runs the real agent, never sends to WhatsApp)</h1>
    <button id="reset">New conversation</button>
  </header>
  <main>
    <div id="chat-col">
      <div id="session-id"></div>
      <div id="thread"></div>
      <form id="composer">
        <input id="input" type="text" placeholder="Type a message as the customer…" autocomplete="off" autofocus />
        <button type="submit" id="send">Send</button>
      </form>
    </div>
    <aside>
      <h2>Session state</h2>
      <div class="row"><span class="k">mode</span><span class="v" id="s-mode">—</span></div>
      <div class="row"><span class="k">order</span><span class="v" id="s-order">—</span></div>
      <div class="row"><span class="k">escalation</span><span class="v" id="s-escalation">—</span></div>
      <div id="cart"></div>
    </aside>
  </main>
  <script>
    const key = ${JSON.stringify(key)};
    const thread = document.getElementById('thread');
    const composer = document.getElementById('composer');
    const input = document.getElementById('input');
    const sendBtn = document.getElementById('send');

    function newSessionId() {
      return 'ui-' + Math.random().toString(36).slice(2, 10);
    }
    let sessionId = localStorage.getItem('testChatSessionId') || newSessionId();
    localStorage.setItem('testChatSessionId', sessionId);
    document.getElementById('session-id').textContent = 'session: ' + sessionId;

    function addMsg(role, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + role;
      el.textContent = text;
      thread.appendChild(el);
      thread.scrollTop = thread.scrollHeight;
    }

    function renderState(state) {
      const modeEl = document.getElementById('s-mode');
      modeEl.innerHTML = '<span class="badge ' + state.mode + '">' + state.mode + '</span>';
      document.getElementById('s-order').textContent = state.orderNumber || '—';
      document.getElementById('s-escalation').textContent = state.escalationReason || '—';
      const cartEl = document.getElementById('cart');
      cartEl.innerHTML = '';
      if (state.cart && state.cart.length) {
        const h = document.createElement('h2');
        h.textContent = 'Cart';
        h.style.marginTop = '10px';
        cartEl.appendChild(h);
        for (const item of state.cart) {
          const row = document.createElement('div');
          row.className = 'item';
          row.textContent = item.quantity + '× ' + item.name + (item.size ? ' (' + item.size + ')' : '');
          cartEl.appendChild(row);
        }
      }
    }

    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      addMsg('user', text);
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;
      try {
        const res = await fetch('/test-chat/message?key=' + encodeURIComponent(key), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, text }),
        });
        const data = await res.json();
        if (!res.ok) {
          addMsg('error', 'Error: ' + (data.message || res.status));
        } else {
          if (data.reply) {
            addMsg('bot', data.reply);
          } else if (data.mode === 'human_handoff') {
            addMsg('system', 'No reply sent — session is in human_handoff' + (data.escalationReason ? ' (' + data.escalationReason + ')' : ''));
          } else {
            addMsg('system', '(no reply this turn)');
          }
          renderState(data);
        }
      } catch (err) {
        addMsg('error', 'Failed to reach the server: ' + err.message);
      } finally {
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
      }
    });

    document.getElementById('reset').addEventListener('click', async () => {
      await fetch('/test-chat/reset?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      sessionId = newSessionId();
      localStorage.setItem('testChatSessionId', sessionId);
      document.getElementById('session-id').textContent = 'session: ' + sessionId;
      thread.innerHTML = '';
      renderState({ mode: 'ai_ordering', cart: [] });
      input.focus();
    });

    renderState({ mode: 'ai_ordering', cart: [] });
  </script>
</body>
</html>`);
});

module.exports = router;
