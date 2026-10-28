"use strict";

module.exports = {
  apps: [
    {
      name: "whatsapp-agent",
      script: "src/index.js",
      cwd: __dirname,
      // Exactly one instance — this service uses SQLite (better-sqlite3)
      // for session/cart state, which allows only one writer process at a
      // time. Do NOT set this to "max" or use PM2 cluster mode; two
      // instances writing the same DB file will corrupt state or crash.
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // No file-watching in production — a restart mid-conversation would
      // drop whatever LLM turn was in flight.
      watch: false,
      max_memory_restart: "300M",
      // Explicit paths (rather than PM2's default ~/.pm2/logs/<name>-*.log)
      // so the in-app /logs viewer has a deterministic place to read from.
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
