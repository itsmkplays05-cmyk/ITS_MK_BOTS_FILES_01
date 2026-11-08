const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ============================ SETTINGS ============================
// Works even if settings.txt is missing (built-in defaults below).
const DEFAULTS = {
  BOT_NAME: 'ITS_GG_BOT',
  SERVER_IP: 'ITS-FRIEND-ONLY-SMP.aternos.me',
  SERVER_PORT: 37984,
  SERVER_VERSION: 'auto',
  LOGIN_PASSWORD: '2345678',
  RANDOM_WALK: true,
  WALK_RADIUS: 100,
  WALK_START_DELAY: 10,
  ANTI_AFK: true,
  CHAT_MESSAGES: false,
  CHAT_DELAY: 25,
  STAY_MINUTES: 30,
  LEAVE_WAIT: 10,
  REJOIN_WAIT: 3,
  DISCORD_WEBHOOK: '',
  DISCORD_NAME: 'GG_BOT Logs',
  DISCORD_CHAT: true,
  DISCORD_PLAYERS: true,
  DISCORD_BOT_EVENTS: true,
  DISCORD_MOVEMENT: false,
  TIMEZONE: 'Asia/Kolkata'
};
const DEFAULT_MESSAGES = [
  'MADE BY Pipka', 'DISCORD SERVER = discord.gg/Jma9yFsqdF', 'SERVER OWNERS pipkagamer',
  'DONT USE XRAY ETC MODE DIRECT BAN', "DON'T ABUSE WITH PLAYERS", 'THANKS FOR COME'
];
const ON = ['on', 'true', 'yes', '1'];
const OFF = ['off', 'false', 'no', '0'];

function loadSettings() {
  const S = { ...DEFAULTS, MESSAGE: [] };
  const warnings = [];
  const apply = (key, val, where) => {
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') {
      const v = val.toLowerCase();
      if (ON.includes(v)) S[key] = true;
      else if (OFF.includes(v)) S[key] = false;
      else warnings.push(`${where}: ${key} must be on or off`);
    } else if (typeof def === 'number') {
      const n = Number(val);
      if (val !== '' && Number.isFinite(n) && n >= 0) S[key] = n;
      else warnings.push(`${where}: ${key} must be a number`);
    } else S[key] = val;
  };

  let text = null;
  try { text = fs.readFileSync(path.join(__dirname, 'settings.txt'), 'utf8').replace(/^\uFEFF/, ''); }
  catch (_) { warnings.push('settings.txt not found, using defaults'); }

  if (text !== null) {
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const eq = line.indexOf('=');
      if (eq < 1) { warnings.push(`line ${i + 1} ignored (no "=")`); return; }
      const key = line.slice(0, eq).trim().toUpperCase().replace(/\s+/g, '_');
      const val = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
      if (key === 'MESSAGE') { if (val) S.MESSAGE.push(val); return; }
      if (!(key in DEFAULTS)) { warnings.push(`line ${i + 1}: unknown setting ${key}`); return; }
      apply(key, val, `line ${i + 1}`);
    });
  } else S.MESSAGE = [...DEFAULT_MESSAGES];

  for (const key of Object.keys(DEFAULTS)) { // Railway Variables override
    const v = process.env[key];
    if (v !== undefined && v !== '') apply(key, String(v).trim(), 'variable');
  }
  S.VERSION = /^(auto|latest|)$/i.test(S.SERVER_VERSION) ? false : S.SERVER_VERSION;
  S.SERVER_PORT = Math.floor(S.SERVER_PORT) || 25565;
  return { S, warnings };
}
const { S, warnings } = loadSettings();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================ LOGS + DISCORD ============================
const TAG = {
  info: 'INFO', chat: 'CHAT', join: 'JOIN', leave: 'LEAVE', kick: 'KICK', error: 'ERROR',
  warn: 'WARN', move: 'MOVE', player_join: 'PLAYER+', player_leave: 'PLAYER-', reconnect: 'RECONNECT', death: 'DEATH'
};
function stamp() {
  try { return new Date().toLocaleTimeString('en-GB', { timeZone: S.TIMEZONE }); }
  catch (_) { return new Date().toLocaleTimeString('en-GB'); }
}
function allowedOnDiscord(kind) {
  if (kind === 'chat') return S.DISCORD_CHAT;
  if (kind === 'player_join' || kind === 'player_leave') return S.DISCORD_PLAYERS;
  if (kind === 'move') return S.DISCORD_MOVEMENT;
  return S.DISCORD_BOT_EVENTS;
}

let queue = [], flushTimer = null, sending = false;
function toDiscord(line) {
  if (!S.DISCORD_WEBHOOK) return;
  queue.push(line.slice(0, 500).replace(/```/g, "'''"));
  if (queue.length > 500) queue.shift();
  if (!flushTimer) flushTimer = setTimeout(flush, 2000);
}
async function post(text) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(S.DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: S.DISCORD_NAME, content: '```\n' + text + '```', allowed_mentions: { parse: [] } })
      });
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}));
        await sleep(((j.retry_after || 2) * 1000) + 300);
        continue;
      }
      if (!r.ok) console.log(`[${stamp()}] WARN Discord webhook error ${r.status}`);
      return;
    } catch (_) { await sleep(2000); }
  }
}
async function flush() {
  flushTimer = null;
  if (sending) { flushTimer = setTimeout(flush, 2000); return; }
  sending = true;
  try {
    while (queue.length) {
      let chunk = '';
      while (queue.length && chunk.length + queue[0].length + 1 < 1850) chunk += queue.shift() + '\n';
      if (chunk) await post(chunk);
      await sleep(400);
    }
  } finally { sending = false; }
}
function log(msg, kind = 'info') {
  const line = `[${stamp()}] ${TAG[kind] || 'INFO'} ${msg}`;
  console.log(line);
  if (allowedOnDiscord(kind)) toDiscord(line);
}

// ============================ HELPERS ============================
function reasonText(r) {
  const skip = new Set(['type', 'color', 'bold', 'italic', 'underlined', 'strikethrough', 'obfuscated', 'font', 'clickEvent', 'hoverEvent', 'insertion']);
  const parts = [];
  const walk = o => {
    if (o == null) return;
    if (typeof o === 'string') { parts.push(o); return; }
    if (typeof o === 'number' || typeof o === 'boolean') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (typeof o === 'object') for (const k of Object.keys(o)) if (!skip.has(k)) walk(o[k]);
  };
  try {
    if (typeof r === 'string') { try { walk(JSON.parse(r)); } catch (_) { parts.push(r); } }
    else walk(r);
  } catch (_) {}
  const out = parts.join('').replace(/§./g, '').trim();
  return out || 'no reason given';
}
function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(t));
}
// Drops broken (NaN / out of range) movement packets -> no "Invalid move player packet" kick.
function guardPackets(b) {
  const c = b._client;
  const orig = c.write.bind(c);
  const names = new Set(['position', 'position_look', 'look', 'flying', 'vehicle_move', 'move_vehicle']);
  let blocked = 0;
  c.write = (name, params) => {
    if (names.has(name) && params) {
      for (const k of ['x', 'y', 'z']) {
        if (k in params && (!Number.isFinite(params[k]) || Math.abs(params[k]) > 2.9e7)) {
          if (++blocked % 20 === 1) log(`blocked bad ${name} packet (${k}=${params[k]})`, 'warn');
          return;
        }
      }
      for (const k of ['yaw', 'pitch']) if (k in params && !Number.isFinite(params[k])) return;
      if ('pitch' in params) params.pitch = Math.max(-90, Math.min(90, params.pitch));
    }
    return orig(name, params);
  };
}

// ============================ BOT ============================
let bot = null, timers = [], session = 0, retrying = false, plannedLeave = false, shuttingDown = false;
let attempts = 0, failsInRow = 0, joinedAt = 0, forcedVersion = null;

function clearAll() {
  session++;
  timers.forEach(t => { clearInterval(t); clearTimeout(t); });
  timers = [];
}
function scheduleRejoin(seconds, why) {
  if (retrying || shuttingDown) return;
  retrying = true;
  clearAll();
  log(`reconnecting in ${seconds}s (${why})`, 'reconnect');
  setTimeout(() => { retrying = false; start(); }, seconds * 1000);
}
function handleEnd(b, why) {
  if (b !== bot || b._done) return;
  b._done = true;
  try { b.end(); } catch (_) {}
  const stayed = joinedAt ? Math.round((Date.now() - joinedAt) / 1000) : 0;
  if (plannedLeave) {
    plannedLeave = false;
    log(`left server, rejoin in ${S.LEAVE_WAIT}s`, 'leave');
    return scheduleRejoin(S.LEAVE_WAIT, 'timed leave');
  }
  if (joinedAt) { failsInRow = 0; log(`connection lost: ${why} (was online ${stayed}s)`, 'leave'); }
  else { failsInRow++; log(`could not join: ${why}`, 'warn'); }
  joinedAt = 0;
  const extra = failsInRow > 2 ? Math.min((failsInRow - 2) * 5, 30) : 0;
  scheduleRejoin(S.REJOIN_WAIT + extra, why);
}

function startRoaming(b, id) {
  const spawn = b.entity.position.clone();
  const R = S.WALK_RADIUS;
  const mv = new Movements(b, require('minecraft-data')(b.version));
  mv.canDig = false; mv.allowParkour = false; mv.allow1by1towers = false;
  b.pathfinder.setMovements(mv);
  b.pathfinder.thinkTimeout = 4000;
  log(`walking within ${R} blocks of spawn (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)}, ${spawn.z.toFixed(0)})`, 'move');
  (async () => {
    while (session === id && b.entity) {
      try {
        const p = b.entity.position;
        let tx = p.x + (Math.random() * 2 - 1) * 30;
        let tz = p.z + (Math.random() * 2 - 1) * 30;
        const dx = tx - spawn.x, dz = tz - spawn.z, d = Math.hypot(dx, dz);
        if (d > R) { tx = spawn.x + dx / d * R; tz = spawn.z + dz / d * R; }
        log(`going to X ${tx.toFixed(0)} Z ${tz.toFixed(0)}`, 'move');
        await withTimeout(b.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 2)), 20000);
      } catch (_) { try { b.pathfinder.stop(); } catch (_) {} }
      if (session !== id) break;
      try { b.swingArm('right'); } catch (_) {}
      await sleep(2000 + Math.random() * 6000);
    }
  })().catch(err => log('walk error: ' + err.message, 'warn'));
}

function start() {
  attempts++;
  log(`connecting to ${S.SERVER_IP}:${S.SERVER_PORT} as ${S.BOT_NAME} (version ${forcedVersion || S.VERSION || 'auto'}) try #${attempts}`);
  let b;
  try {
    b = mineflayer.createBot({
      host: S.SERVER_IP, port: S.SERVER_PORT, username: S.BOT_NAME, version: forcedVersion || S.VERSION, auth: 'offline',
      checkTimeoutInterval: 120000, // laggy servers won't cause false "timed out"
      connectTimeout: 30000
    });
  } catch (err) {
    log('create failed: ' + err.message, 'error');
    return scheduleRejoin(S.REJOIN_WAIT + 5, 'create failed');
  }
  bot = b;
  const id = session;
  let ready = false;

  guardPackets(b);
  b.loadPlugin(pathfinder);
  b.physicsEnabled = false;
  if (b.physics) b.physics.enabled = false;

  timers.push(setTimeout(() => { if (!joinedAt) handleEnd(b, 'join timeout 60s'); }, 60000));

  b.once('spawn', () => {
    joinedAt = Date.now(); failsInRow = 0;
    log(`joined server (version ${b.version})`, 'join');
    timers.push(setTimeout(() => { ready = true; }, 4000));

    const spawnT = Date.now();
    const pw = S.LOGIN_PASSWORD;
    const auth = { done: !pw, sent: 0, last: 0, login: false, register: false, walk: false };

    const beginWalk = () => {
      if (session !== id || !b.entity) return;
      if (!Number.isFinite(b.entity.position.x) || !Number.isFinite(b.entity.position.y)) {
        log('bad spawn position, rejoining', 'warn');
        return b.quit();
      }
      b.physicsEnabled = true;
      if (b.physics) b.physics.enabled = true;
      if (S.RANDOM_WALK) startRoaming(b, id);
    };
    const scheduleWalk = () => {
      if (auth.walk) return;
      auth.walk = true;
      const at = Math.max(spawnT + S.WALK_START_DELAY * 1000, Date.now() + 3000);
      timers.push(setTimeout(beginWalk, Math.max(at - Date.now(), 0)));
    };
    const say = (cmd) => {
      if (auth.done || auth.sent >= 6) return;
      const wait = 2500 - (Date.now() - auth.last);
      if (wait > 0) { timers.push(setTimeout(() => say(cmd), wait + 100)); return; }
      auth.sent++; auth.last = Date.now();
      try { b.chat(cmd); log('sent ' + cmd.split(' ')[0]); } catch (_) {}
    };
    const doLogin = () => { if (!auth.login) { auth.login = true; say(`/login ${pw}`); } };
    const doRegister = () => { if (!auth.register) { auth.register = true; say(`/register ${pw} ${pw}`); } };

    if (pw) {
      b._authMsg = (text) => {
        if (auth.done) return;
        const t = text.toLowerCase();
        const bad = /(wrong|incorrect|invalid|failed|not |already|error|fail)/.test(t);
        if (!bad && /(success|logged in|authenticated|welcome back|now logged)/.test(t)) {
          auth.done = true; log('login OK'); return scheduleWalk();
        }
        if (/already (registered|have an account)|is registered/.test(t)) return doLogin();
        const wantsLogin = /\/?log ?in/.test(t), wantsReg = /register/.test(t);
        if (wantsLogin && wantsReg) { doLogin(); timers.push(setTimeout(doRegister, 4000)); }
        else if (wantsLogin) doLogin();
        else if (wantsReg) doRegister();
      };
      timers.push(setTimeout(doLogin, 6000));          // no prompt seen: try login
      timers.push(setTimeout(doRegister, 11000));      // still nothing: try register
      timers.push(setTimeout(() => {                   // stop waiting, carry on
        if (!auth.done) { auth.done = true; log('login not confirmed, continuing', 'warn'); scheduleWalk(); }
      }, 22000));
    } else scheduleWalk();

    if (S.ANTI_AFK) timers.push(setInterval(() => { try { b.swingArm('right'); } catch (_) {} }, 20000));

    if (S.CHAT_MESSAGES && S.MESSAGE.length) {
      let i = 0;
      timers.push(setInterval(() => {
        try { b.chat(S.MESSAGE[i]); } catch (_) {}
        i = (i + 1) % S.MESSAGE.length;
      }, Math.max(S.CHAT_DELAY, 1) * 1000));
    }
    if (S.STAY_MINUTES > 0) {
      timers.push(setTimeout(() => {
        log(`${S.STAY_MINUTES} minutes done, leaving`, 'leave');
        plannedLeave = true;
        b.quit();
      }, S.STAY_MINUTES * 60 * 1000));
    }
  });

  b.on('messagestr', (msg, pos) => {
    if (pos === 'game_info' || !msg || !msg.trim()) return;
    log(msg, 'chat');
    if (b._authMsg) b._authMsg(msg);
  });
  b.on('playerJoined', p => { if (ready && p.username !== b.username) log(`${p.username} joined`, 'player_join'); });
  b.on('playerLeft', p => { if (ready && p.username !== b.username) log(`${p.username} left`, 'player_leave'); });
  b.on('death', () => log('bot died, respawning', 'death'));
  b.on('kicked', r => log(`kicked: ${reasonText(r)}`, 'kick'));
  b.on('error', err => {
    log(`${err.code ? err.code + ' ' : ''}${err.message}`, 'error');
    if (!joinedAt && !forcedVersion && /not supported|unsupported/i.test(err.message) && mineflayer.latestSupportedVersion) {
      forcedVersion = mineflayer.latestSupportedVersion;
      log(`server version not supported, trying ${forcedVersion}`, 'warn');
    }
    timers.push(setTimeout(() => { if (!joinedAt) handleEnd(b, err.code || err.message); }, 3000));
  });
  b.on('end', reason => handleEnd(b, reason || 'connection ended'));
}

// ============================ RUN ============================
process.on('uncaughtException', err => log('uncaught: ' + err.message, 'error'));
process.on('unhandledRejection', err => log('unhandled: ' + (err && err.message || err), 'error'));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    shuttingDown = true;
    log('shutting down', 'warn');
    try { if (bot) bot.quit(); } catch (_) {}
    await flush().catch(() => {});
    setTimeout(() => process.exit(0), 500);
  });
}
warnings.forEach(w => log('settings: ' + w, 'warn'));
log(`started | walk ${S.RANDOM_WALK ? 'on' : 'off'} | chat ${S.CHAT_MESSAGES ? 'on' : 'off'} | stay ${S.STAY_MINUTES}min | discord ${S.DISCORD_WEBHOOK ? 'on' : 'off'}`);
start();
