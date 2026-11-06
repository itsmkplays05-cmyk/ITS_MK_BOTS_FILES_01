"use strict";

const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { addLog, getLogs } = require("./logger");

// ---- Safe settings loader: tolerates missing keys, BOM and bad JSON ----
const DEFAULTS = {
  name: "AFK Bot",
  "bot-account": { username: "AFKBot", password: "", type: "offline" },
  server: { ip: "localhost", port: 25565, version: "", "try-creative": false },
  position: { enabled: false, x: 0, y: 100, z: 0 },
  utils: {
    "auto-auth": { enabled: false, password: "" },
    "anti-afk": { enabled: true, sneak: false },
    "chat-messages": { enabled: false, repeat: true, "repeat-delay": 120, messages: [] },
    "auto-reconnect": true, "auto-reconnect-delay": 2000, "max-reconnect-delay": 120000,
  },
  movement: {
    enabled: true, "safe-mode": false, "start-delay": 8,
    "look-around": { enabled: true, interval: 5000 },
    "random-jump": { enabled: false, interval: 10000 },
    wander: { enabled: true, radius: 100, "min-step": 8, "max-step": 30, "pause-min": 2000, "pause-max": 8000 },
  },
  modules: { avoidMobs: false, combat: false, beds: false, chat: true },
  combat: { "attack-mobs": true, "auto-eat": true },
  beds: { "place-night": false },
  discord: { enabled: false, webhookUrl: "", events: { connect: true, disconnect: true, chat: false } },
  chat: { respond: true },
};
function deepMerge(base, extra) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return extra === undefined ? base : extra;
  const out = { ...base };
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    for (const k of Object.keys(extra)) out[k] = deepMerge(base[k], extra[k]);
  }
  return out;
}
function loadConfig() {
  const file = path.join(__dirname, "settings.json");
  try {
    const raw = require("fs").readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch (err) {
    console.error(`[Config] settings.json is invalid: ${err.message}`);
    console.error("[Config] Using default settings. Fix settings.json (check commas and quotes).");
    return DEFAULTS;
  }
}
const config = loadConfig();

const { GoalBlock, GoalXZ } = goals;
const move = config.movement || {};
const num = (v) => typeof v === "number" && Number.isFinite(v);

// ============================================================
// STATE
// ============================================================
const state = {
  running: true,
  connected: false,
  safeMode: !!move["safe-mode"],
  startTime: Date.now(),
  connectedAt: null,
  reconnectAttempts: 0,
  kicks: 0,
  lastKick: null,
  wasThrottled: false,
};

let bot = null;
let intervals = [];
let reconnectTimer = null;
let connectTimer = null;
let isReconnecting = false;
let lastDiscordSend = 0;

// ============================================================
// WEB SERVER (dashboard + API)
// ============================================================
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store"); // never let a proxy/browser cache logs or status
  next();
});
const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/logs", (req, res) => res.redirect("/"));
app.get("/ping", (req, res) => res.send("pong"));

app.get("/health", (req, res) => {
  const p = bot && bot.entity ? bot.entity.position : null;
  res.json({
    name: config.name,
    status: state.connected ? "connected" : state.running ? "connecting" : "stopped",
    running: state.running,
    safeMode: state.safeMode,
    uptime: state.connectedAt ? Math.floor((Date.now() - state.connectedAt) / 1000) : 0,
    processUptime: Math.floor((Date.now() - state.startTime) / 1000),
    coords: p ? { x: p.x, y: p.y, z: p.z } : null,
    username: config["bot-account"].username,
    server: `${config.server.ip}:${config.server.port}`,
    version: bot && bot.version ? bot.version : config.server.version || "auto",
    reconnectAttempts: state.reconnectAttempts,
    kicks: state.kicks,
    lastKick: state.lastKick,
    memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
  });
});

app.get("/api/logs", (req, res) => res.json({ logs: getLogs() }));

app.post("/start", (req, res) => {
  if (state.running) return res.json({ success: false, msg: "Bot is already running." });
  state.running = true;
  state.reconnectAttempts = 0;
  addLog("[Control] Bot started");
  createBot();
  res.json({ success: true, msg: "Bot started." });
});

app.post("/stop", (req, res) => {
  if (!state.running) return res.json({ success: false, msg: "Bot is already stopped." });
  state.running = false;
  clearTimers();
  isReconnecting = false;
  destroyBot();
  addLog("[Control] Bot stopped");
  res.json({ success: true, msg: "Bot stopped." });
});

app.post("/safe-mode", (req, res) => {
  state.safeMode = !!req.body.enabled;
  addLog(`[Control] Safe mode ${state.safeMode ? "enabled" : "disabled"} - applies from next join`);
  res.json({ success: true, safeMode: state.safeMode, msg: `Safe mode ${state.safeMode ? "on" : "off"}. Applies on next join.` });
});

app.post("/command", (req, res) => {
  const cmd = String((req.body && req.body.command) || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });
  addLog(`[Console] > ${cmd}`);

  const reply = (success, msg) => {
    msg.split("\n").forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success, msg });
  };

  if (cmd === "/help") {
    return reply(true, [
      "/help            Show this list",
      "/pos             Bot coordinates",
      "/status          Connection status",
      "/safemode on|off Toggle safe movement mode",
      "/say <text>      Send chat message",
      "/<command>       Send a server command",
      "<text>           Send plain chat",
    ].join("\n"));
  }
  if (cmd === "/pos") {
    const p = bot && bot.entity ? bot.entity.position : null;
    return reply(!!p, p ? `X=${Math.floor(p.x)} Y=${Math.floor(p.y)} Z=${Math.floor(p.z)}` : "Position unavailable - bot is not in the world.");
  }
  if (cmd === "/status") {
    return reply(true, `${state.connected ? "Connected" : "Not connected"} | safe mode ${state.safeMode ? "on" : "off"} | reconnects ${state.reconnectAttempts} | kicks ${state.kicks}`);
  }
  if (cmd.startsWith("/safemode")) {
    state.safeMode = cmd.split(/\s+/)[1] !== "off";
    return reply(true, `Safe mode ${state.safeMode ? "on" : "off"}. Applies on next join.`);
  }
  if (!bot || !state.connected) return reply(false, "Bot is not connected.");

  try {
    bot.chat(cmd.startsWith("/say ") ? cmd.slice(5) : cmd);
    return reply(true, `Sent: ${cmd}`);
  } catch (err) {
    return reply(false, err.message);
  }
});

const server = app.listen(PORT, "0.0.0.0", () => addLog(`[Server] Dashboard on port ${server.address().port}`));
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    addLog(`[Server] Port ${PORT} in use - trying ${Number(PORT) + 1}`);
    server.listen(Number(PORT) + 1, "0.0.0.0");
  } else addLog(`[Server] Error: ${err.message}`);
});

// Keep-alive for Render
if (process.env.RENDER_EXTERNAL_URL) {
  const url = process.env.RENDER_EXTERNAL_URL;
  setInterval(() => {
    (url.startsWith("https") ? https : http)
      .get(`${url}/ping`, () => {})
      .on("error", (e) => addLog(`[KeepAlive] ${e.message}`));
  }, 10 * 60 * 1000);
}

// ============================================================
// TIMERS / CLEANUP
// ============================================================
function clearTimers() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (connectTimer) clearTimeout(connectTimer);
  reconnectTimer = connectTimer = null;
}

function clearAllIntervals() {
  intervals.forEach((id) => clearInterval(id));
  intervals = [];
}

function addInterval(fn, ms) {
  intervals.push(setInterval(fn, ms));
}

// Safely tear down the current bot. A no-op error listener is kept so late
// socket errors can never crash the process after listeners are removed.
function destroyBot() {
  clearAllIntervals();
  state.connected = false;
  state.connectedAt = null;
  if (!bot) return;
  const old = bot;
  bot = null;
  try {
    old.removeAllListeners();
    old.on("error", () => {});
    old.end();
  } catch (_) {}
}

function reconnectDelay() {
  if (state.wasThrottled) {
    state.wasThrottled = false;
    return 60000 + Math.floor(Math.random() * 60000);
  }
  const base = config.utils["auto-reconnect-delay"] || 3000;
  const max = config.utils["max-reconnect-delay"] || 30000;
  return Math.min(base * Math.pow(2, state.reconnectAttempts), max) + Math.floor(Math.random() * 2000);
}

function scheduleReconnect() {
  if (!state.running || isReconnecting) return;
  if (config.utils["auto-reconnect"] === false) return;
  clearTimers();
  isReconnecting = true;
  state.reconnectAttempts++;
  const delay = reconnectDelay();
  addLog(`[Bot] Reconnecting in ${Math.round(delay / 1000)}s (attempt #${state.reconnectAttempts})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// BOT
// ============================================================
function createBot() {
  if (!state.running || isReconnecting) return;
  destroyBot();

  const version = config.server.version && String(config.server.version).trim() ? config.server.version : false;
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port} (version ${version || "auto"})`);

  try {
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version,
      hideErrors: false,
      checkTimeoutInterval: 600000,
    });
  } catch (err) {
    addLog(`[Bot] Failed to create bot: ${err.message}`);
    return scheduleReconnect();
  }

  const current = bot;
  bot.loadPlugin(pathfinder);

  clearTimers();
  connectTimer = setTimeout(() => {
    if (bot === current && !state.connected) {
      addLog("[Bot] Connection timeout - no spawn received");
      destroyBot();
      scheduleReconnect();
    }
  }, 150000);

  bot.once("spawn", () => onSpawn(current));

  bot.on("kicked", (reason) => {
    const text = typeof reason === "object" ? JSON.stringify(reason) : String(reason);
    addLog(`[Bot] Kicked: ${text}`);
    state.kicks++;
    state.lastKick = text.length > 140 ? text.slice(0, 140) + "…" : text;
    state.connected = false;
    clearAllIntervals();

    const lower = text.toLowerCase();
    if (lower.includes("throttl") || lower.includes("wait before reconnect") || lower.includes("too fast")) {
      state.wasThrottled = true;
    }
    // "Invalid movement" kick -> rejoin with movement switched off
    if ((lower.includes("invalid") && lower.includes("movement")) || lower.includes("moved wrongly") || lower.includes("moved too quickly")) {
      if (!state.safeMode) addLog("[Bot] Invalid-movement kick detected - enabling safe mode (no walking) for next join");
      state.safeMode = true;
    }
    notify(`[!] **Kicked**: ${text}`, 0xff0000, "disconnect");
  });

  bot.on("end", (reason) => {
    if (bot !== current) return;
    addLog(`[Bot] Disconnected: ${reason || "unknown reason"}`);
    notify(`[-] **Disconnected**: ${reason || "Unknown"}`, 0xf87171, "disconnect");
    destroyBot();
    scheduleReconnect();
  });

  bot.on("error", (err) => addLog(`[Bot] Error: ${err.message || err}`));
}

async function onSpawn(self) {
  if (bot !== self) return;
  clearTimers();
  state.connected = true;
  state.connectedAt = Date.now();
  state.reconnectAttempts = 0;
  isReconnecting = false;
  addLog(`[Bot] Spawned on server (version ${self.version})${state.safeMode ? " - SAFE MODE" : ""}`);
  notify(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80, "connect");

  const mcData = require("minecraft-data")(self.version);
  const movements = new Movements(self, mcData);
  movements.canDig = false;
  movements.allowParkour = false;
  movements.allow1by1towers = false;
  movements.allowSprinting = false;
  movements.scafoldingBlocks = [];
  movements.liquidCost = 1000;
  movements.fallDamageCost = 1000;

  const authDone = setupAuth(self);
  setupChatMessages(self);
  setupAntiAfk(self);
  if (config.modules.combat) combatModule(self);
  if (config.modules.chat) chatModule(self);
  if (config.modules.beds) bedModule(self);

  // Do NOT walk until the world is loaded and login is finished. Moving while the
  // server holds the player in its login/limbo state is what triggers "Invalid movement".
  const delay = (num(move["start-delay"]) ? move["start-delay"] : 8) * 1000;
  try {
    await Promise.race([self.waitForChunksToLoad(), sleep(15000)]);
    await Promise.race([authDone, sleep(15000)]);
    await sleep(delay);
  } catch (_) {}
  if (bot !== self || !state.connected) return;

  if (config.server["try-creative"]) self.chat("/gamemode creative");

  if (state.safeMode) {
    addLog("[Movement] Safe mode: walking and jumping disabled, bot stays in place");
    if (config.utils["anti-afk"] && config.utils["anti-afk"].sneak) self.setControlState("sneak", true);
  } else if (move.enabled !== false) {
    startMovement(self, movements);
  }
  if (move["look-around"] && move["look-around"].enabled && move.enabled !== false) startLookAround(self);
  addLog("[Modules] Ready");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// MODULES
// ============================================================
function setupAuth(self) {
  const auth = config.utils["auto-auth"];
  if (!auth || !auth.enabled) return Promise.resolve();

  return new Promise((resolve) => {
    let handled = false;
    const send = (type) => {
      if (handled || bot !== self) return;
      handled = true;
      self.chat(type === "register" ? `/register ${auth.password} ${auth.password}` : `/login ${auth.password}`);
      addLog(`[Auth] Sent /${type}`);
      setTimeout(resolve, 2500);
    };
    self.on("messagestr", (m) => {
      if (handled) return;
      const t = m.toLowerCase();
      if (t.includes("/register") || t.includes("register ")) send("register");
      else if (t.includes("/login") || t.includes("login ")) send("login");
    });
    setTimeout(() => {
      if (!handled) {
        addLog("[Auth] No prompt seen - sending /login as failsafe");
        send("login");
      }
    }, 10000);
  });
}

function setupChatMessages(self) {
  const cm = config.utils["chat-messages"];
  if (!cm || !cm.enabled || !cm.messages.length) return;
  if (cm.repeat) {
    let i = 0;
    addInterval(() => {
      if (bot === self && state.connected) {
        self.chat(cm.messages[i]);
        i = (i + 1) % cm.messages.length;
      }
    }, cm["repeat-delay"] * 1000);
  } else {
    cm.messages.forEach((m, i) => setTimeout(() => bot === self && state.connected && self.chat(m), i * 1000));
  }
}

// Anti-AFK that never moves the bot's position
function setupAntiAfk(self) {
  if (!config.utils["anti-afk"] || !config.utils["anti-afk"].enabled) return;
  addInterval(() => {
    try { if (bot === self && state.connected) self.swingArm(); } catch (_) {}
  }, 15000 + Math.floor(Math.random() * 30000));
  addInterval(() => {
    try { if (bot === self && state.connected) self.setQuickBarSlot(Math.floor(Math.random() * 9)); } catch (_) {}
  }, 30000 + Math.floor(Math.random() * 60000));
}

function startMovement(self, movements) {
  const w = move["wander"];

  if (w && w.enabled) {
    const radius = w.radius || 100;
    const minStep = w["min-step"] || 8;
    const maxStep = w["max-step"] || 30;
    const pauseMin = w["pause-min"] || 2000;
    const pauseMax = w["pause-max"] || 8000;
    const home = self.entity.position.clone(); // 100-block limit is measured from here
    let nextAt = 0;

    movements.maxDropDown = 3;
    self.pathfinder.thinkTimeout = 5000;
    self.pathfinder.setMovements(movements);

    addInterval(() => {
      if (bot !== self || !state.connected || !self.entity) return;
      if (self.pathfinder.isMoving() || Date.now() < nextAt) return;

      const p = self.entity.position;
      let tx, tz;
      if (Math.hypot(p.x - home.x, p.z - home.z) > radius) {
        tx = home.x; tz = home.z; // drifted out of range -> head back
      } else {
        for (let i = 0; i < 10; i++) { // pick a random spot that stays inside the radius
          const ang = Math.random() * Math.PI * 2;
          const dist = minStep + Math.random() * (maxStep - minStep);
          tx = p.x + Math.cos(ang) * dist;
          tz = p.z + Math.sin(ang) * dist;
          if (Math.hypot(tx - home.x, tz - home.z) <= radius) break;
        }
      }
      if (!num(tx) || !num(tz)) return;
      nextAt = Date.now() + pauseMin + Math.random() * (pauseMax - pauseMin);
      try { self.pathfinder.setGoal(new GoalXZ(Math.floor(tx), Math.floor(tz))); } catch (e) { addLog("[Wander]", e); }
    }, 1500);
    addLog(`[Movement] Random wander started (radius ${radius} blocks)`);
  } else if (config.position && config.position.enabled) {
    self.pathfinder.setMovements(movements);
    self.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
    addLog("[Position] Navigating to configured position");
  }

  if (!(w && w.enabled) && move["random-jump"] && move["random-jump"].enabled) {
    addInterval(() => {
      if (bot !== self || !state.connected) return;
      self.setControlState("jump", true);
      setTimeout(() => bot === self && self.setControlState("jump", false), 300);
    }, move["random-jump"].interval || 10000);
  }
}

function startLookAround(self) {
  addInterval(() => {
    if (bot !== self || !state.connected) return;
    const yaw = Math.random() * Math.PI * 2 - Math.PI;
    const pitch = Math.random() * (Math.PI / 2) - Math.PI / 4;
    try { self.look(yaw, pitch, false); } catch (_) {}
  }, move["look-around"].interval || 5000);
}

function combatModule(self) {
  let last = 0;
  self.on("physicsTick", () => {
    if (!state.connected || !config.combat["attack-mobs"] || Date.now() - last < 620) return;
    try {
      const mob = Object.values(self.entities).find(
        (e) => e.type === "mob" && e.position && self.entity.position.distanceTo(e.position) < 4,
      );
      if (mob) { self.attack(mob); last = Date.now(); }
    } catch (_) {}
  });
  self.on("health", () => {
    if (!config.combat["auto-eat"] || self.food >= 14) return;
    const food = self.inventory.items().find((i) => i.foodPoints > 0);
    if (food) self.equip(food, "hand").then(() => self.consume()).catch(() => {});
  });
}

function chatModule(self) {
  self.on("chat", (username, message) => {
    if (username === self.username) return;
    if (config.discord && config.discord.events && config.discord.events.chat) {
      sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
    }
    if (config.chat && config.chat.respond && /\b(hello|hi)\b/i.test(message)) {
      self.chat(`Hello, ${username}!`);
    }
  });
}

function bedModule(self) {
  let busy = false;
  addInterval(async () => {
    if (!state.connected || busy || !config.beds["place-night"]) return;
    const t = self.time.timeOfDay;
    if (t < 12500 || t > 23500) return;
    const bed = self.findBlock({ matching: (b) => b.name.includes("bed"), maxDistance: 8 });
    if (!bed) return;
    busy = true;
    try { await self.sleep(bed); addLog("[Bed] Sleeping"); } catch (_) {} finally { busy = false; }
  }, 10000);
}

// ============================================================
// DISCORD
// ============================================================
function notify(text, color, event) {
  if (config.discord && config.discord.events && config.discord.events[event]) sendDiscordWebhook(text, color);
}

function sendDiscordWebhook(content, color = 0x0099ff) {
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
