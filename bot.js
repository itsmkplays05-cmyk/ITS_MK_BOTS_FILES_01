'use strict';
// =====================================================================
//  GG BOT v7.0  -  3 BOT ROTATION  (Railway ready)
//
//  - ITS_GG_BOT -> ITS_GG_02 -> ITS_GG_03 -> ITS_GG_BOT -> ... (loop)
//  - Only one bot is "on duty" for ROTATE_HOURS (default 3 hours).
//  - When the time is over the NEXT bot joins first, and the old bot
//    leaves a few seconds later -> server is never empty.
//  - If the next bot cannot join (whitelist, name problem, etc.) the old
//    bot stays online and the next-next bot is tried. Nothing breaks.
//  - Every bot uses the same join / login / walking logic as before.
//  - All settings come from settings.txt (Railway Variables override it).
// =====================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ============================ SETTINGS ============================
// Works even if settings.txt is missing (built-in defaults below).
const MAX_BOTS = 10;
const DEFAULTS = {
  BOT_NAME: 'ITS_GG_BOT',        // bot 1 (starts first)
  BOT_NAME_2: 'ITS_GG_02',       // bot 2
  BOT_NAME_3: 'ITS_GG_03',       // bot 3
  SERVER_IP: 'ITS-FRIEND-ONLY-SMP.aternos.me',
  SERVER_PORT: 37984,
  SERVER_VERSION: 'auto',
  LOGIN_PASSWORD: '2345678',

  ROTATE_HOURS: 3,               // how long ONE bot stays before the next one takes over (0 = no rotation)
  SEAMLESS_SWITCH: true,         // next bot joins first, old bot leaves after it (server never empty)
  HANDOVER_OVERLAP: 10,          // seconds both bots stay together during a switch
  HANDOVER_TIMEOUT: 120,         // seconds to wait for the next bot to join before giving up on it
  SWITCH_RETRY_MINUTES: 5,       // if nobody could take over, try again after this many minutes
  STATUS_LOG_MINUTES: 10,        // print a status line every N minutes (0 = off)
  STATUS_PAGE: true,             // tiny status web page (uses the PORT that Railway gives)
  STATUS_PORT: 3000,             // port for the status page when PORT is not set

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
for (let i = 4; i <= MAX_BOTS; i++) DEFAULTS[`BOT_NAME_${i}`] = ''; // optional extra bots
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

  // bot names in rotation order (BOT_NAME, BOT_NAME_2, BOT_NAME_3, ...)
  const names = [], seen = new Set();
  for (let i = 1; i <= MAX_BOTS; i++) {
    const key = i === 1 ? 'BOT_NAME' : `BOT_NAME_${i}`;
    const nm = String(S[key] || '').trim();
    if (!nm) continue;
    if (seen.has(nm.toLowerCase())) { warnings.push(`${key}: "${nm}" is a duplicate name, ignored`); continue; }
    if (!/^[A-Za-z0-9_]{3,16}$/.test(nm)) warnings.push(`${key}: "${nm}" is not a normal Minecraft name (3-16 letters, numbers or _)`);
    seen.add(nm.toLowerCase());
    names.push(nm);
  }
  if (!names.length) names.push(DEFAULTS.BOT_NAME);
  S.BOT_NAMES = names;
  S.SLOT_MS = Math.round(S.ROTATE_HOURS * 3600 * 1000);
  return { S, warnings };
}
const { S, warnings } = loadSettings();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================ LOGS + DISCORD ============================
const TAG = {
  info: 'INFO', chat: 'CHAT', join: 'JOIN', leave: 'LEAVE', kick: 'KICK', error: 'ERROR',
  warn: 'WARN', move: 'MOVE', player_join: 'PLAYER+', player_leave: 'PLAYER-', reconnect: 'RECONNECT',
  death: 'DEATH', rotate: 'ROTATE', status: 'STATUS'
};
function stamp() {
  try { return new Date().toLocaleTimeString('en-GB', { timeZone: S.TIMEZONE }); }
  catch (_) { return new Date().toLocaleTimeString('en-GB'); }
}
function clockAt(ms) {
  try { return new Date(ms).toLocaleTimeString('en-GB', { timeZone: S.TIMEZONE }); }
  catch (_) { return new Date(ms).toLocaleTimeString('en-GB'); }
}
function fmtDur(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function allowedOnDiscord(kind) {
  if (kind === 'status') return false; // periodic status lines stay in the console only
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
function log(msg, kind = 'info', who = '') {
  const line = `[${stamp()}] ${TAG[kind] || 'INFO'}${who ? ' [' + who + ']' : ''} ${msg}`;
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
function guardPackets(b, who) {
  const c = b._client;
  const orig = c.write.bind(c);
  const names = new Set(['position', 'position_look', 'look', 'flying', 'vehicle_move', 'move_vehicle']);
  let blocked = 0;
  c.write = (name, params) => {
    if (names.has(name) && params) {
      for (const k of ['x', 'y', 'z']) {
        if (k in params && (!Number.isFinite(params[k]) || Math.abs(params[k]) > 2.9e7)) {
          if (++blocked % 20 === 1) log(`blocked bad ${name} packet (${k}=${params[k]})`, 'warn', who);
          return;
        }
      }
      for (const k of ['yaw', 'pitch']) if (k in params && !Number.isFinite(params[k])) return;
      if ('pitch' in params) params.pitch = Math.max(-90, Math.min(90, params.pitch));
    }
    return orig(name, params);
  };
}

// ============================ SHARED STATE ============================
const shared = { forcedVersion: null }; // server version problem is the same for every bot
let shuttingDown = false;

// ============================ ONE BOT (WORKER) ============================
// A Worker is one bot name. It can be switched ON (activate) or OFF (deactivate)
// by the Rotator. While ON it joins, logs in, walks and reconnects by itself.
class Worker {
  constructor(name, index) {
    this.name = name;
    this.index = index;
    this.bot = null;
    this.timers = [];
    this.session = 0;
    this.active = false;     // should this bot be on the server right now?
    this.online = false;     // connected and spawned
    this.settled = false;    // login finished (or no login needed) -> safe to hand over
    this.retrying = false;
    this.rejoinTimer = null;
    this.plannedLeave = false;
    this.attempts = 0;
    this.failsInRow = 0;
    this.joinedAt = 0;
  }

  log(msg, kind = 'info') { log(msg, kind, this.name); }

  clearAll() {
    this.session++;
    this.timers.forEach(t => { clearInterval(t); clearTimeout(t); });
    this.timers = [];
  }

  activate() {
    if (this.active || shuttingDown) return;
    this.active = true;
    this.attempts = 0;
    this.failsInRow = 0;
    this.plannedLeave = false;
    this.retrying = false;
    this.start();
  }

  deactivate(why = 'rotation') {
    if (!this.active && !this.bot) return;
    this.active = false;
    this.log(`stopping (${why})`, 'leave');
    this.clearAll();
    if (this.rejoinTimer) { clearTimeout(this.rejoinTimer); this.rejoinTimer = null; }
    this.retrying = false;
    this.plannedLeave = false;
    const b = this.bot;
    this.bot = null;
    this.online = false;
    this.settled = false;
    this.joinedAt = 0;
    if (b) {
      b._done = true;
      try { b.quit(); } catch (_) {}
      setTimeout(() => { try { b.end(); } catch (_) {} }, 1500);
    }
  }

  shutdown() {
    this.active = false;
    this.clearAll();
    if (this.rejoinTimer) { clearTimeout(this.rejoinTimer); this.rejoinTimer = null; }
    try { if (this.bot) { this.bot._done = true; this.bot.quit(); } } catch (_) {}
  }

  // Safety net: an active bot must always be connected or have a reconnect pending.
  watchdog() {
    if (!this.active || shuttingDown) return;
    if (!this.bot && !this.retrying) {
      this.log('watchdog: no connection and no reconnect pending - restarting', 'warn');
      this.start();
    }
  }

  waitReady(ms) {
    return (async () => {
      const end = Date.now() + ms;
      while (Date.now() < end && !shuttingDown) {
        if (this.online && this.settled) return true;
        if (!this.active) return false;
        await sleep(250);
      }
      return this.online && this.settled;
    })();
  }

  scheduleRejoin(seconds, why) {
    if (this.retrying || shuttingDown || !this.active) return;
    this.retrying = true;
    this.clearAll();
    this.log(`reconnecting in ${seconds}s (${why})`, 'reconnect');
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      this.retrying = false;
      if (this.active && !shuttingDown) this.start();
    }, seconds * 1000);
  }

  handleEnd(b, why) {
    if (b !== this.bot || b._done) return;
    b._done = true;
    try { b.end(); } catch (_) {}
    this.online = false;
    this.settled = false;
    const stayed = this.joinedAt ? Math.round((Date.now() - this.joinedAt) / 1000) : 0;
    if (this.plannedLeave) {
      this.plannedLeave = false;
      this.joinedAt = 0;
      this.log(`left server, rejoin in ${S.LEAVE_WAIT}s`, 'leave');
      return this.scheduleRejoin(S.LEAVE_WAIT, 'timed leave');
    }
    if (this.joinedAt) { this.failsInRow = 0; this.log(`connection lost: ${why} (was online ${stayed}s)`, 'leave'); }
    else { this.failsInRow++; this.log(`could not join: ${why}`, 'warn'); }
    this.joinedAt = 0;
    const extra = this.failsInRow > 2 ? Math.min((this.failsInRow - 2) * 5, 30) : 0;
    this.scheduleRejoin(S.REJOIN_WAIT + extra, why);
  }

  startRoaming(b, id) {
    const spawn = b.entity.position.clone();
    const R = S.WALK_RADIUS;
    const mv = new Movements(b, require('minecraft-data')(b.version));
    mv.canDig = false; mv.allowParkour = false; mv.allow1by1towers = false;
    b.pathfinder.setMovements(mv);
    b.pathfinder.thinkTimeout = 4000;
    this.log(`walking within ${R} blocks of spawn (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)}, ${spawn.z.toFixed(0)})`, 'move');
    (async () => {
      while (this.session === id && b.entity) {
        try {
          const p = b.entity.position;
          let tx = p.x + (Math.random() * 2 - 1) * 30;
          let tz = p.z + (Math.random() * 2 - 1) * 30;
          const dx = tx - spawn.x, dz = tz - spawn.z, d = Math.hypot(dx, dz);
          if (d > R) { tx = spawn.x + dx / d * R; tz = spawn.z + dz / d * R; }
          this.log(`going to X ${tx.toFixed(0)} Z ${tz.toFixed(0)}`, 'move');
          await withTimeout(b.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 2)), 20000);
        } catch (_) { try { b.pathfinder.stop(); } catch (_) {} }
        if (this.session !== id) break;
        try { b.swingArm('right'); } catch (_) {}
        await sleep(2000 + Math.random() * 6000);
      }
    })().catch(err => this.log('walk error: ' + err.message, 'warn'));
  }

  start() {
    if (!this.active || shuttingDown) return;
    this.attempts++;
    this.joinedAt = 0;
    this.online = false;
    this.settled = false;
    const ver = shared.forcedVersion || S.VERSION;
    this.log(`connecting to ${S.SERVER_IP}:${S.SERVER_PORT} as ${this.name} (version ${ver || 'auto'}) try #${this.attempts}`);
    let b;
    try {
      b = mineflayer.createBot({
        host: S.SERVER_IP, port: S.SERVER_PORT, username: this.name, version: ver, auth: 'offline',
        checkTimeoutInterval: 120000, // laggy servers won't cause false "timed out"
        connectTimeout: 30000
      });
    } catch (err) {
      this.log('create failed: ' + err.message, 'error');
      return this.scheduleRejoin(S.REJOIN_WAIT + 5, 'create failed');
    }
    this.bot = b;
    const id = this.session;
    let ready = false;

    guardPackets(b, this.name);
    b.loadPlugin(pathfinder);

    // Self-heal: some server/library version combos give a NaN position -> bad move packets / disconnects.
    const finite3 = v => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    let lastGood = null, healLogged = 0, tpLogged = false;
    const heal = () => {
      const e = b.entity;
      if (!e) return false;
      if (finite3(e.position)) lastGood = e.position.clone();
      else if (lastGood) {
        e.position.set(lastGood.x, lastGood.y, lastGood.z);
        if (healLogged++ % 50 === 0) this.log('fixed invalid position', 'warn');
      }
      if (!finite3(e.velocity)) e.velocity.set(0, 0, 0);
      if (!Number.isFinite(e.yaw)) e.yaw = 0;
      if (!Number.isFinite(e.pitch)) e.pitch = 0;
      return finite3(e.position);
    };
    // The server's teleport is the truth for our position. Apply it BEFORE and AFTER the library's own handler,
    // so the bot never sends a wrong position (this is what spams "moved too quickly" on the server).
    const relFlag = (p, name, bit) => {
      const f = p.flags;
      if (typeof f === 'number') return (f & bit) !== 0;
      if (f && typeof f === 'object') return !!f[name];
      return false;
    };
    let lastTp = null, syncs = 0;
    const syncFromServer = p => {
      const e = b.entity;
      if (!e || !p) return;
      if (!tpLogged) { tpLogged = true; this.log(`server teleport x=${p.x} y=${p.y} z=${p.z}`); }
      if (!(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) return;
      const rel = relFlag(p, 'x', 1) || relFlag(p, 'y', 2) || relFlag(p, 'z', 4);
      if (!rel) {
        e.position.set(p.x, p.y, p.z);
        lastTp = { x: p.x, y: p.y, z: p.z };
        if (!finite3(e.velocity)) e.velocity.set(0, 0, 0);
        if (syncs++ % 25 === 0) this.log(`position synced with server (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}) x${syncs}`, 'warn');
      } else if (!finite3(e.position)) e.position.set(p.x, p.y, p.z);
    };
    b._client.prependListener('position', p => { try { syncFromServer(p); } catch (_) {} });
    b._client.on('position', p => { try { syncFromServer(p); heal(); } catch (_) {} });
    b.on('physicsTick', heal);
    b.physicsEnabled = false;
    if (b.physics) b.physics.enabled = false;

    this.timers.push(setTimeout(() => { if (!this.joinedAt) this.handleEnd(b, 'join timeout 60s'); }, 60000));

    b.once('spawn', () => {
      if (b !== this.bot) return; // this bot was switched off while it was still joining
      this.joinedAt = Date.now(); this.failsInRow = 0; this.online = true;
      this.log(`joined server (version ${b.version})`, 'join');
      this.timers.push(setTimeout(() => { ready = true; }, 4000));

      const spawnT = Date.now();
      const pw = S.LOGIN_PASSWORD;
      const auth = { done: !pw, sent: 0, last: 0, login: false, register: false, walk: false };

      const beginWalk = (n = 0) => {
        if (this.session !== id || !b.entity) return;
        if (lastTp && b.entity && Math.hypot(b.entity.position.x - lastTp.x, b.entity.position.z - lastTp.z) > 2) {
          b.entity.position.set(lastTp.x, lastTp.y, lastTp.z);
          this.log('position corrected before walking', 'warn');
        }
        if (heal()) {
          b.physicsEnabled = true;
          if (b.physics) b.physics.enabled = true;
          if (S.RANDOM_WALK) this.startRoaming(b, id);
          return;
        }
        if (n === 0) this.log('waiting for a valid position', 'warn');
        if (n < 15) this.timers.push(setTimeout(() => beginWalk(n + 1), 2000));
        else this.log('position still invalid - staying in place (not disconnecting)', 'warn');
      };
      const scheduleWalk = () => {
        this.settled = true; // login is finished -> this bot is fully ready (rotation waits for this)
        if (auth.walk) return;
        auth.walk = true;
        const at = Math.max(spawnT + S.WALK_START_DELAY * 1000, Date.now() + 3000);
        this.timers.push(setTimeout(() => beginWalk(0), Math.max(at - Date.now(), 0)));
      };
      const say = (cmd) => {
        if (auth.done || auth.sent >= 6) return;
        const wait = 2500 - (Date.now() - auth.last);
        if (wait > 0) { this.timers.push(setTimeout(() => say(cmd), wait + 100)); return; }
        auth.sent++; auth.last = Date.now();
        try { b.chat(cmd); this.log('sent ' + cmd.split(' ')[0]); } catch (_) {}
      };
      const doLogin = () => { if (!auth.login) { auth.login = true; say(`/login ${pw}`); } };
      const doRegister = () => { if (!auth.register) { auth.register = true; say(`/register ${pw} ${pw}`); } };

      if (pw) {
        b._authMsg = (text) => {
          if (auth.done) return;
          const t = text.toLowerCase();
          const bad = /(wrong|incorrect|invalid|failed|not |already|error|fail)/.test(t);
          if (!bad && /(success|logged in|authenticated|welcome back|now logged)/.test(t)) {
            auth.done = true; this.log('login OK'); return scheduleWalk();
          }
          if (/already (registered|have an account)|is registered/.test(t)) return doLogin();
          const wantsLogin = /\/?log ?in/.test(t), wantsReg = /register/.test(t);
          if (wantsLogin && wantsReg) { doLogin(); this.timers.push(setTimeout(doRegister, 4000)); }
          else if (wantsLogin) doLogin();
          else if (wantsReg) doRegister();
        };
        this.timers.push(setTimeout(doLogin, 6000));          // no prompt seen: try login
        this.timers.push(setTimeout(doRegister, 11000));      // still nothing: try register
        this.timers.push(setTimeout(() => {                   // stop waiting, carry on
          if (!auth.done) { auth.done = true; this.log('login not confirmed, continuing', 'warn'); scheduleWalk(); }
        }, 22000));
      } else scheduleWalk();

      if (S.ANTI_AFK) this.timers.push(setInterval(() => { try { b.swingArm('right'); } catch (_) {} }, 20000));

      if (S.CHAT_MESSAGES && S.MESSAGE.length) {
        let i = 0;
        this.timers.push(setInterval(() => {
          try { b.chat(S.MESSAGE[i]); } catch (_) {}
          i = (i + 1) % S.MESSAGE.length;
        }, Math.max(S.CHAT_DELAY, 1) * 1000));
      }
      if (S.STAY_MINUTES > 0) {
        this.timers.push(setTimeout(() => {
          this.log(`${S.STAY_MINUTES} minutes done, leaving`, 'leave');
          this.plannedLeave = true;
          b.quit();
        }, S.STAY_MINUTES * 60 * 1000));
      }
    });

    b.on('messagestr', (msg, pos) => {
      if (b !== this.bot) return;
      if (pos === 'game_info' || !msg || !msg.trim()) return;
      this.log(msg, 'chat');
      if (b._authMsg) b._authMsg(msg);
    });
    b.on('playerJoined', p => { if (b === this.bot && ready && p.username !== b.username) this.log(`${p.username} joined`, 'player_join'); });
    b.on('playerLeft', p => { if (b === this.bot && ready && p.username !== b.username) this.log(`${p.username} left`, 'player_leave'); });
    b.on('death', () => { if (b === this.bot) this.log('bot died, respawning', 'death'); });
    b.on('kicked', r => { if (b === this.bot) this.log(`kicked: ${reasonText(r)}`, 'kick'); });
    b.on('error', err => {
      if (b !== this.bot) return;
      this.log(`${err.code ? err.code + ' ' : ''}${err.message}`, 'error');
      if (!this.joinedAt && !shared.forcedVersion && /not supported|unsupported/i.test(err.message) && mineflayer.latestSupportedVersion) {
        shared.forcedVersion = mineflayer.latestSupportedVersion;
        this.log(`server version not supported, trying ${shared.forcedVersion}`, 'warn');
      }
      this.timers.push(setTimeout(() => { if (!this.joinedAt) this.handleEnd(b, err.code || err.message); }, 3000));
    });
    b.on('end', reason => this.handleEnd(b, reason || 'connection ended'));
  }
}

// ============================ ROTATOR ============================
// Decides which bot is on duty. Every ROTATE_HOURS the next bot takes over.
class Rotator {
  constructor(workers) {
    this.workers = workers;
    this.activeIdx = 0;
    this.slotStartedAt = 0;
    this.nextSwitchAt = 0;
    this.switching = false;
    this.switches = 0;
    this.failedSwitches = 0;
    this.tickTimer = null;
    this.statusTimer = null;
    this.watchTimer = null;
    this.enabled = workers.length > 1 && S.SLOT_MS > 0;
  }

  get current() { return this.workers[this.activeIdx]; }
  nextBot() { return this.workers[(this.activeIdx + 1) % this.workers.length]; }

  start() {
    this.slotStartedAt = Date.now();
    this.nextSwitchAt = this.slotStartedAt + S.SLOT_MS;
    const order = this.workers.map(w => w.name).join(' -> ');
    if (this.enabled) {
      log(`rotation ON: ${order} -> (repeat) | ${S.ROTATE_HOURS} hour(s) per bot | next switch at ${clockAt(this.nextSwitchAt)}`, 'rotate');
    } else if (this.workers.length < 2) {
      log(`rotation OFF: only one bot name is set (${order})`, 'rotate');
    } else {
      log(`rotation OFF: ROTATE_HOURS is 0, only ${this.current.name} will run`, 'rotate');
    }
    this.current.activate();
    if (this.enabled) this.tickTimer = setInterval(() => this.tick(), 1000);
    if (S.STATUS_LOG_MINUTES > 0) this.statusTimer = setInterval(() => this.statusLine(), S.STATUS_LOG_MINUTES * 60000);
    this.watchTimer = setInterval(() => this.workers.forEach(w => w.watchdog()), 30000);
  }

  stop() {
    [this.tickTimer, this.statusTimer, this.watchTimer].forEach(t => { if (t) clearInterval(t); });
    this.tickTimer = this.statusTimer = this.watchTimer = null;
  }

  tick() {
    if (shuttingDown || this.switching) return;
    if (Date.now() < this.nextSwitchAt) return;
    this.switching = true;
    this.switchNext()
      .catch(err => log('switch error: ' + err.message, 'error'))
      .finally(() => { this.switching = false; });
  }

  async switchNext() {
    const n = this.workers.length;
    const from = this.current;
    const startedAt = Date.now();
    for (let k = 1; k < n; k++) {
      if (shuttingDown) return;
      const to = this.workers[(this.activeIdx + k) % n];
      const ok = await this.handover(from, to);
      if (ok) {
        this.activeIdx = to.index;
        this.switches++;
        this.slotStartedAt = startedAt;
        this.nextSwitchAt = startedAt + S.SLOT_MS;
        log(`switch done: ${to.name} is on duty now | next: ${this.nextBot().name} at ${clockAt(this.nextSwitchAt)}`, 'rotate');
        return;
      }
    }
    if (shuttingDown) return;
    this.failedSwitches++;
    this.nextSwitchAt = Date.now() + S.SWITCH_RETRY_MINUTES * 60000;
    log(`no other bot could join - ${from.name} stays on duty, trying again in ${S.SWITCH_RETRY_MINUTES} min`, 'warn');
  }

  // Returns true when `to` has taken over from `from`.
  async handover(from, to) {
    const seamless = S.SEAMLESS_SWITCH;
    log(`time is up for ${from.name} -> switching to ${to.name}${seamless ? ' (new bot joins first, old bot leaves after)' : ' (old bot leaves first)'}`, 'rotate');
    if (!seamless) { from.deactivate('rotation'); await sleep(3000); }
    to.activate();
    const ok = await to.waitReady(S.HANDOVER_TIMEOUT * 1000);
    if (shuttingDown) return false;
    if (!ok) {
      to.deactivate('could not join');
      if (!seamless) from.activate(); // put the old bot back
      log(`${to.name} could not join within ${S.HANDOVER_TIMEOUT}s - ${from.name} stays`, 'warn');
      return false;
    }
    if (seamless) {
      if (from.online && S.HANDOVER_OVERLAP > 0) await sleep(S.HANDOVER_OVERLAP * 1000);
      if (shuttingDown) return false;
      if (!to.online) { // new bot dropped right after joining -> keep the old one
        to.deactivate('dropped right after joining');
        log(`${to.name} was disconnected right after joining - ${from.name} stays`, 'warn');
        return false;
      }
      from.deactivate('rotation');
    }
    return true;
  }

  statusLine() {
    const w = this.current, now = Date.now();
    const state = w.online ? `online for ${fmtDur(now - w.joinedAt)}` : (w.active ? 'connecting / reconnecting' : 'stopped');
    const nxt = this.enabled
      ? ` | next switch -> ${this.nextBot().name} in ${fmtDur(this.nextSwitchAt - now)} (at ${clockAt(this.nextSwitchAt)})`
      : ' | rotation off';
    log(`${w.name} ${state}${nxt} | switches done: ${this.switches}`, 'status');
  }

  snapshot() {
    const now = Date.now();
    return {
      status: 'running',
      uptime: fmtDur(process.uptime() * 1000),
      rotation: {
        enabled: this.enabled,
        order: this.workers.map(w => w.name),
        hoursPerBot: S.ROTATE_HOURS,
        activeBot: this.current.name,
        nextBot: this.enabled ? this.nextBot().name : null,
        nextSwitchAt: this.enabled ? new Date(this.nextSwitchAt).toISOString() : null,
        nextSwitchIn: this.enabled ? fmtDur(this.nextSwitchAt - now) : null,
        switchingNow: this.switching,
        switchesDone: this.switches,
        failedSwitches: this.failedSwitches
      },
      bots: this.workers.map(w => ({
        name: w.name,
        active: w.active,
        online: w.online,
        ready: w.settled,
        onlineFor: w.online && w.joinedAt ? fmtDur(now - w.joinedAt) : null,
        tries: w.attempts
      }))
    };
  }
}

// ============================ STATUS PAGE ============================
// Optional. Open the Railway public URL to see which bot is on duty and when the next switch happens.
// It never shows the server IP or any password.
let statusServer = null;
function startStatusPage(rot) {
  if (!S.STATUS_PAGE) return;
  const port = Number(process.env.PORT) || S.STATUS_PORT;
  statusServer = http.createServer((req, res) => {
    try {
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(rot.snapshot(), null, 2));
    } catch (_) { try { res.writeHead(500); res.end('error'); } catch (_) {} }
  });
  statusServer.on('error', err => log('status page: ' + err.message, 'warn'));
  statusServer.listen(port, '0.0.0.0', () => log(`status page is on port ${port} (/ = status, /health = ok)`));
}

// ============================ RUN ============================
process.on('uncaughtException', err => log('uncaught: ' + err.message, 'error'));
process.on('unhandledRejection', err => log('unhandled: ' + (err && err.message || err), 'error'));

warnings.forEach(w => log('settings: ' + w, 'warn'));
const workers = S.BOT_NAMES.map((name, i) => new Worker(name, i));
const rotator = new Rotator(workers);

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} received - shutting down`, 'warn');
  rotator.stop();
  workers.forEach(w => { try { w.shutdown(); } catch (_) {} });
  try { if (statusServer) statusServer.close(); } catch (_) {}
  await flush().catch(() => {});
  setTimeout(() => process.exit(0), 800);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => shutdown(sig));

log(`started | bots ${S.BOT_NAMES.join(', ')} | ${S.ROTATE_HOURS}h each | walk ${S.RANDOM_WALK ? 'on' : 'off'} | chat ${S.CHAT_MESSAGES ? 'on' : 'off'} | stay ${S.STAY_MINUTES}min | discord ${S.DISCORD_WEBHOOK ? 'on' : 'off'}`);
rotator.start();
startStatusPage(rotator);
