  const d = config.discord;
  if (!d || !d.enabled || !d.webhookUrl) return;
  if (Date.now() - lastDiscordSend < 5000) return;
  lastDiscordSend = Date.now();

  const url = new URL(d.webhookUrl);
  const payload = JSON.stringify({
    username: config.name,
    embeds: [{ description: content, color, timestamp: new Date().toISOString() }],
  });
  const req = https.request(
    { hostname: url.hostname, path: url.pathname + url.search, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } },
    () => {},
  );
  req.on("error", (e) => addLog(`[Discord] ${e.message}`));
  req.end(payload);
}

// ============================================================
// CRASH RECOVERY
// ============================================================
function recover(label, err) {
  addLog(`[FATAL] ${label}: ${err && err.message ? err.message : err}`);
  if (!state.running) return;
  destroyBot();
  isReconnecting = false;
  clearTimers();
  scheduleReconnect();
}

process.on("uncaughtException", (err) => recover("Uncaught exception", err));
process.on("unhandledRejection", (reason) => recover("Unhandled rejection", reason));
process.on("SIGTERM", () => addLog("[System] SIGTERM ignored"));
process.on("SIGINT", () => addLog("[System] SIGINT ignored"));

// ============================================================
// START
// ============================================================
addLog(`Minecraft AFK Bot v3.0 | ${config.server.ip}:${config.server.port} | version ${config.server.version || "auto"}`);
createBot();
