'use strict';
// =====================================================================
//  GG BOT v9.0  -  Multi-bot AFK rotation for Minecraft (Railway ready)
//
//  - Bots rotate in order: BOT_NAME -> BOT_NAME_2 -> BOT_NAME_3 -> ...
//  - Only one bot is "on duty" for ROTATE_HOURS. The next bot joins first,
//    then the old bot leaves, so the server is never empty.
//  - Smart version join: ping -> exact version -> if it fails, ALL versions newest -> oldest.
//  - 10 second quiet time after joining (no movement packets), then walking.
//  - Self-healing connection: server ping before join, exponential backoff,
//    kick-reason aware retry delays, stale-connection detection, watchdog.
//  - Random walk inside WALK_RADIUS blocks of the spawn point (no circles).
//  - Live dashboard on the Railway public URL ( / ), JSON on /api/status.
//  - All settings come from settings.txt (Railway Variables override it).
// =====================================================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

let protocolLib = null; // used only for the optional "is the server up?" ping
try { protocolLib = require('minecraft-protocol'); } catch (_) { /* optional */ }

// ============================ SETTINGS ============================
// Works even if settings.txt is missing (built-in defaults below).
const MAX_BOTS = 10;
const DEFAULTS = {
  BOT_NAME: 'ITS_GG_01',
  BOT_NAME_2: 'ITS_GG_02',
  BOT_NAME_3: 'ITS_GG_03',
  SERVER_IP: 'ITS-FRIEND-ONLY-SMP.aternos.me',
  SERVER_PORT: 37984,
  SERVER_VERSION: 'auto',
  VERSION_FALLBACKS: '',   // optional: versions tried first when the detected one fails (after that ALL versions are tried)
  LOGIN_PASSWORD: '2345678',

  ROTATE_HOURS: 3,
  SEAMLESS_SWITCH: true,
  HANDOVER_OVERLAP: 10,
  HANDOVER_TIMEOUT: 120,
  SWITCH_RETRY_MINUTES: 5,
  STATUS_LOG_MINUTES: 10,
  STATUS_PAGE: true,
  STATUS_PORT: 3000,
  CONSOLE_LINES: 500,      // lines kept for the live console on the dashboard
  DASHBOARD_PASSWORD: '',  // empty = public page, otherwise the page asks for this password

  RANDOM_WALK: true,
  WALK_RADIUS: 100,
  WALK_START_DELAY: 10,
  ANTI_AFK: true,

  CHAT_MESSAGES: false,
  CHAT_DELAY: 25,

  STAY_MINUTES: 0,
  LEAVE_WAIT: 10,

  // connection stability
  REJOIN_WAIT: 5,          // first reconnect delay (seconds), doubles after every failure
  REJOIN_MAX: 20,          // reconnect delay never goes above this (seconds)
  JOIN_TIMEOUT: 45,        // give up a join attempt after this many seconds
  STALE_TIMEOUT: 75,       // no data from the server for this long = dead connection (0 = off)
  PING_BEFORE_JOIN: true,  // check that the server is up before joining (saves spam)
  OFFLINE_RETRY: 15,       // wait this long when the server is offline / starting (seconds)
  JOIN_HANG_SECONDS: 20,   // connected but no login after this long = try the next version (0 = off)

  DISCORD_WEBHOOK: '',
  DISCORD_NAME: 'GG_BOT Logs',
  DISCORD_CHAT: true,
  DISCORD_PLAYERS: true,
  DISCORD_BOT_EVENTS: true,
  DISCORD_MOVEMENT: false,
  TIMEZONE: 'Asia/Kolkata'
};
for (let i = 4; i <= MAX_BOTS; i++) DEFAULTS[`BOT_NAME_${i}`] = '';
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

  for (const key of Object.keys(DEFAULTS)) { // Railway Variables override settings.txt
    const v = process.env[key];
    if (v !== undefined && v !== '') apply(key, String(v).trim(), 'variable');
  }
  S.VERSION = /^(auto|latest|)$/i.test(S.SERVER_VERSION) ? false : S.SERVER_VERSION;
  S.SERVER_PORT = Math.floor(S.SERVER_PORT) || 25565;
  S.FALLBACKS = String(S.VERSION_FALLBACKS || '').split(',').map(v => v.trim()).filter(Boolean);
  S.REJOIN_WAIT = Math.max(S.REJOIN_WAIT, 1);
  S.REJOIN_MAX = Math.max(S.REJOIN_MAX, S.REJOIN_WAIT);
  S.JOIN_TIMEOUT = Math.max(S.JOIN_TIMEOUT, 15);
  S.OFFLINE_RETRY = Math.max(S.OFFLINE_RETRY, 5);
  S.CONSOLE_LINES = Math.min(Math.max(Math.floor(S.CONSOLE_LINES) || 500, 50), 2000);
  if (S.JOIN_HANG_SECONDS > 0) S.JOIN_HANG_SECONDS = Math.max(S.JOIN_HANG_SECONDS, 10);
  S.WALK_START_DELAY = Math.max(S.WALK_START_DELAY, 10); // never move earlier than 10s after joining
  S.WALK_RADIUS = Math.max(S.WALK_RADIUS, 10);
  if (S.STALE_TIMEOUT > 0) S.STALE_TIMEOUT = Math.max(S.STALE_TIMEOUT, 30);

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
// Live console buffer (shown on the dashboard). Server IP, password and webhook are hidden here.
const consoleBuf = [];
let consoleId = 0;
function redact(text) {
  let t = String(text);
  if (S.SERVER_IP) t = t.split(S.SERVER_IP).join('<server>');
  if (S.LOGIN_PASSWORD && String(S.LOGIN_PASSWORD).length >= 4) t = t.split(String(S.LOGIN_PASSWORD)).join('***');
  if (S.DISCORD_WEBHOOK) t = t.split(S.DISCORD_WEBHOOK).join('<webhook>');
  return t;
}
function pushConsole(kind, who, msg) {
  consoleBuf.push({ id: ++consoleId, t: Date.now(), kind, tag: TAG[kind] || 'INFO', who, msg: redact(msg).slice(0, 400) });
  if (consoleBuf.length > S.CONSOLE_LINES) consoleBuf.shift();
}
function log(msg, kind = 'info', who = '') {
  const line = `[${stamp()}] ${TAG[kind] || 'INFO'}${who ? ' [' + who + ']' : ''} ${msg}`;
  console.log(line);
  try { pushConsole(kind, who, String(msg)); } catch (_) {}
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
// Random point 10-30 blocks from the bot, always inside R blocks of the spawn point.
// Near the edge the bot is sent back toward the spawn (no hugging the border, no circles).
function pickTarget(p, spawn, R) {
  if (Math.hypot(p.x - spawn.x, p.z - spawn.z) > R * 0.97) return { x: spawn.x, z: spawn.z, home: true };
  for (let i = 0; i < 10; i++) {
    const ang = Math.random() * Math.PI * 2, dist = 10 + Math.random() * 20;
    const tx = p.x + Math.cos(ang) * dist, tz = p.z + Math.sin(ang) * dist;
    if (Math.hypot(tx - spawn.x, tz - spawn.z) <= R * 0.95) return { x: tx, z: tz };
  }
  const ang = Math.atan2(spawn.z - p.z, spawn.x - p.x) + (Math.random() - 0.5);
  const dist = 10 + Math.random() * 20;
  return { x: p.x + Math.cos(ang) * dist, z: p.z + Math.sin(ang) * dist };
}

// Messages that mean "the bot speaks a different protocol than the server" (wrong version).
const VERSION_ERR = /bad packet|invalid packet|decoderexception|badly compressed|larger than i expected|unknown packet|illegal packet|could not be decoded|protocol error|partial ?read|chunk size is|only \d+ was read|varint is too big|unknown (state|packet id)|deserializ/i;

// Decides how long to wait before the next join attempt, based on WHY the last one ended.
function retryPlan(text, fails) {
  const t = String(text || '').toLowerCase();
  let wait = Math.min(S.REJOIN_MAX, S.REJOIN_WAIT * Math.pow(2, Math.max(0, fails - 1)));
  let note = '', versionProblem = false, afk = false, moveProblem = false;
  if (/throttl|too (fast|quickly)|wait before reconnect/.test(t)) {
    wait = Math.max(wait, 15); note = 'server is throttling fast reconnects';
  } else if (/banned|ban reason|you are ban/.test(t)) {
    wait = Math.max(wait, 300); note = 'this bot name is BANNED on the server (unban it or change the name)';
  } else if (/white-?list/.test(t)) {
    wait = Math.max(wait, 60); note = 'bot name is not whitelisted (add it to the whitelist)';
  } else if (/already (online|connected|logged)|another location|duplicate|same name|name is taken/.test(t)) {
    wait = Math.max(wait, 20); note = 'same name is still online on the server';
  } else if (/server (is )?full|is full/.test(t)) {
    wait = Math.max(wait, 30); note = 'server is full';
  } else if (/afk|idle|inactiv|away from keyboard|not moving|no movement/.test(t)) {
    wait = Math.max(Math.min(wait, 8), 3); afk = true; note = 'kicked for being AFK - the bot moves more from now on';
  } else if (/invalid move|moved too quickly|moved wrongly|illegal position|invalid position/.test(t)) {
    wait = Math.max(wait, 8); moveProblem = true; note = 'server did not like a movement packet - the quiet time after joining is longer now';
  } else if (VERSION_ERR.test(t) || /outdated|incompatible|unsupported|not supported|protocol/.test(t)) {
    wait = Math.max(Math.min(wait, 10), 5); note = 'version mismatch between bot and server - trying another version'; versionProblem = true;
  } else if (/closed|restart|stopping|shutting down|going down/.test(t)) {
    wait = Math.max(wait, 15); note = 'server is restarting';
  }
  return { wait: Math.round(wait + Math.random() * 2), note, versionProblem, afk, moveProblem };
}
// ============================ SERVER CHECK ============================
// Pings the server (no login) to see if it is up and which version it reports.
const probe = { at: 0, result: { state: 'unknown' } };
async function probeServer() {
  if (!protocolLib || typeof protocolLib.ping !== 'function') return { state: 'unknown' };
  if (Date.now() - probe.at < 8000) return probe.result;
  let result;
  try {
    const r = await withTimeout(new Promise((resolve, reject) => {
      protocolLib.ping({ host: S.SERVER_IP, port: S.SERVER_PORT, closeTimeout: 8000 }, (err, res) => (err ? reject(err) : resolve(res)));
    }), 10000);
    const vname = String((r && r.version && r.version.name) || '');
    const motd = reasonText(r && r.description);
    const aternos = /aternos\.(me|host|org)$/i.test(S.SERVER_IP);
    // Aternos answers pings even when the server is stopped - detect that, but only for Aternos hosts.
    const sleeping = aternos && (
      (r.version && r.version.protocol === -1) ||
      /^\W*(offline|starting|stopping|loading|saving|preparing)/i.test(vname) ||
      /server is (offline|starting|stopping|loading|saving|preparing)|in queue/i.test(motd)
    );
    result = {
      state: sleeping ? 'offline' : 'online',
      version: vname.replace(/§./g, '').trim() || null,
      protocol: r && r.version ? r.version.protocol : null,
      players: r && r.players ? r.players.online : null,
      max: r && r.players ? r.players.max : null
    };
  } catch (err) {
    result = { state: 'offline', error: err.code || err.message };
  }
  probe.at = Date.now();
  probe.result = result;
  return result;
}

// ============================ VERSIONS ============================
// Every release the installed library can speak, newest -> oldest, one entry per protocol.
// A join walks this list when the first guess does not work, so ALL versions can be reached.
const shared = { tried: new Set(), versionHintAt: 0, goodVersion: null, ladder: null, ladderKey: null, ladderPos: 0, afkLevel: 0, quietBoost: 0, newerNoted: false };
let mdLib = null;
try { mdLib = require('minecraft-data'); } catch (_) { /* optional */ }
const verParts = v => String(v).split('.').map(n => parseInt(n, 10) || 0);
function cmpVer(a, b) { // > 0 when a is newer than b
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}
function libSupports(v) {
  if (!mdLib || !v) return false;
  try {
    const d = mdLib(String(v));
    if (!d || !d.version) return false;
    const sup = mineflayer.supportedVersions;
    if (!Array.isArray(sup) || !sup.length) return true;
    return sup.includes(String(v)) || sup.includes(d.version.majorVersion) || sup.includes(d.version.minecraftVersion);
  } catch (_) { return false; }
}
const VERS = (() => {
  const byProto = new Map();
  const list = (mdLib && mdLib.versions && mdLib.versions.pc) || [];
  for (const x of list) {
    const v = x && x.minecraftVersion;
    if (!v || !/^\d+\.\d+(\.\d+)?$/.test(v)) continue;                       // releases only, no snapshots
    if (!Number.isFinite(x.version) || x.version < 47 || x.version > 100000) continue; // 1.8 and newer
    if (!libSupports(v)) continue;
    const have = byProto.get(x.version);
    if (!have || cmpVer(v, have) > 0) byProto.set(x.version, v);
  }
  let all = [...byProto.values()].sort((a, b) => cmpVer(b, a));
  if (!all.length && mineflayer.latestSupportedVersion) all = [mineflayer.latestSupportedVersion];
  return { all, byProto, minProto: Math.min(...byProto.keys(), Infinity) };
})();
// Does the installed library speak this protocol natively? (true / false)
function libKnowsProtocol(protocol) { return VERS.byProto.has(protocol); }

// Order of versions to try, based on what the server ping told us.
function makeLadder(pr) {
  const out = [];
  const add = v => { if (v !== undefined && v !== null && !out.includes(v)) out.push(v); };
  const proto = pr && pr.protocol;
  if (proto && VERS.byProto.has(proto)) add(VERS.byProto.get(proto));            // exact match
  else if (proto && proto > 0 && proto < VERS.minProto) add(VERS.all[VERS.all.length - 1]); // older than 1.8
  else if (proto && proto > 0) add(VERS.all[0]);                                 // newer than the library: newest it has (ViaBackwards)
  else add(false);                                                                // no info: let mineflayer detect
  S.FALLBACKS.forEach(v => { if (libSupports(v)) add(v); });
  VERS.all.forEach(add);
  return out;
}
function getLadder() { // rebuilt when the server's protocol changes (server was updated)
  const key = String((probe.result && probe.result.protocol) || '');
  if (!shared.ladder || shared.ladderKey !== key) {
    shared.ladder = makeLadder(probe.result);
    shared.ladderKey = key;
    shared.ladderPos = 0;
    shared.tried.clear();
  }
  return shared.ladder;
}
// "Outdated client! Please use 1.21.4" -> 1.21.4
function versionFromText(text, except) {
  const found = String(text || '').match(/\b\d{1,2}\.\d{1,2}(?:\.\d{1,2})?\b/g) || [];
  for (const v of found) if (v !== except && libSupports(v)) return v;
  return null;
}
function advanceLadder(who, from, why, text) {
  if (S.VERSION) return;
  const ladder = getLadder();
  if (ladder.length < 2) return;
  shared.goodVersion = null;
  shared.tried.add(from);
  let pos;
  let hint = versionFromText(text, from);
  if (hint && shared.tried.has(hint)) hint = null; // never bounce between two versions
  if (hint && ladder.includes(hint)) {
    pos = ladder.indexOf(hint);
  } else {
    hint = null;
    let idx = ladder.indexOf(from);
    if (idx < 0) idx = shared.ladderPos;
    pos = idx + 1;
    if (pos >= ladder.length) { pos = 0; shared.tried.clear(); versionHint(); }
  }
  shared.ladderPos = pos;
  const next = ladder[pos];
  log(`${why} with version ${from || 'auto'} - next try uses ${next || 'auto detect'}${hint ? ' (server told us this version)' : ''} [${pos + 1}/${ladder.length}]`, 'warn', who);
}
let shuttingDown = false;

function versionHint() {
  const latest = mineflayer.latestSupportedVersion || 'unknown';
  if (Date.now() - shared.versionHintAt < 600000) return;
  shared.versionHintAt = Date.now();
  log(`every version up to Minecraft ${latest} was tried. If the server is NEWER than that, install BOTH ViaVersion and ViaBackwards on the server ` +
    '(ViaBackwards is the one that lets older bots join), or redeploy later - a fresh Railway build pulls the newest mineflayer automatically.', 'warn');
}

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
    this.startToken = 0;
    this.active = false;     // should this bot be on the server right now?
    this.online = false;     // connected and spawned
    this.settled = false;    // login finished (or no login needed) -> safe to hand over
    this.probing = false;
    this.retrying = false;
    this.rejoinTimer = null;
    this.plannedLeave = false;
    this.attempts = 0;
    this.failsInRow = 0;
    this.offlineStreak = 0;
    this.joinedAt = 0;
    this.lastKick = '';
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
    this.offlineStreak = 0;
    this.plannedLeave = false;
    this.retrying = false;
    this.probing = false;
    this.start();
  }

  deactivate(why = 'rotation') {
    if (!this.active && !this.bot) return;
    this.active = false;
    this.log(`stopping (${why})`, 'leave');
    this.startToken++;
    this.clearAll();
    if (this.rejoinTimer) { clearTimeout(this.rejoinTimer); this.rejoinTimer = null; }
    this.retrying = false;
    this.probing = false;
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
    this.startToken++;
    this.clearAll();
    if (this.rejoinTimer) { clearTimeout(this.rejoinTimer); this.rejoinTimer = null; }
    try { if (this.bot) { this.bot._done = true; this.bot.quit(); } } catch (_) {}
  }

  // Safety net: an active bot must always be connected, probing, or have a reconnect pending.
  watchdog() {
    if (!this.active || shuttingDown) return;
    if (!this.bot && !this.retrying && !this.probing) {
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
    this.bot = null;
    this.online = false;
    this.settled = false;
    const stayed = this.joinedAt ? Math.round((Date.now() - this.joinedAt) / 1000) : 0;
    const reason = this.lastKick || String(why || 'connection ended');
    this.lastKick = '';
    if (this.plannedLeave) {
      this.plannedLeave = false;
      this.joinedAt = 0;
      this.log(`left server, rejoin in ${S.LEAVE_WAIT}s`, 'leave');
      return this.scheduleRejoin(S.LEAVE_WAIT, 'timed leave');
    }
    if (this.joinedAt) {
      if (stayed < 15) this.failsInRow++; else this.failsInRow = 0;
      this.log(`connection lost: ${reason} (was online ${stayed}s)`, 'leave');
    } else {
      this.failsInRow++;
      this.log(`could not join: ${reason}`, 'warn');
      if (shared.goodVersion) { shared.goodVersion = null; shared.ladderPos = 0; } // server may have changed version: guess again
    }
    this.joinedAt = 0;
    const plan = retryPlan(reason, this.failsInRow);
    if (plan.note) this.log(plan.note, 'warn');
    if (plan.versionProblem) advanceLadder(this.name, this.lastVer, 'version refused', reason);
    if (plan.afk) shared.afkLevel = Math.min(3, shared.afkLevel + 1);
    if (plan.moveProblem) shared.quietBoost = Math.min(30, shared.quietBoost + 5);
    this.scheduleRejoin(plan.wait, reason);
  }

  // ---------- random walk (stays inside WALK_RADIUS blocks of the spawn point) ----------
  startRoaming(b, id) {
    const spawn = b.entity.position.clone();
    const R = S.WALK_RADIUS;
    let usePathfinder = true;
    try {
      let data = b.registry;
      if (!data) data = require('minecraft-data')(b.version);
      const mv = new Movements(b, data);
      mv.canDig = false; mv.allowParkour = false; mv.allow1by1towers = false;
      mv.allowSprinting = false;   // saves food, looks calmer
      mv.maxDropDown = 3;          // never jump off high places
      b.pathfinder.setMovements(mv);
      b.pathfinder.thinkTimeout = 2500; // short thinking = no lag, keep-alive packets are never late
      b.pathfinder.tickTimeout = 10;
    } catch (err) {
      usePathfinder = false;
      this.log(`pathfinder not available (${err.message}) - using simple walking`, 'warn');
    }
    this.log(`walking within ${R} blocks of spawn (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)}, ${spawn.z.toFixed(0)})`, 'move');
    (async () => {
      let pfFails = 0;
      while (this.session === id && b === this.bot) {
        if (!b.entity) { await sleep(1000); continue; }
        const t = pickTarget(b.entity.position, spawn, R);
        const away = Math.round(Math.hypot(b.entity.position.x - spawn.x, b.entity.position.z - spawn.z));
        this.log(`${t.home ? 'going back to spawn' : `going to X ${t.x.toFixed(0)} Z ${t.z.toFixed(0)}`} (${away}/${R} blocks from spawn)`, 'move');
        try {
          if (usePathfinder) {
            await withTimeout(b.pathfinder.goto(new goals.GoalNearXZ(t.x, t.z, 2)), 15000);
            pfFails = 0;
          } else await this.walkSimple(b, id, t);
        } catch (_) {
          try { b.pathfinder.stop(); } catch (_) {}
          if (usePathfinder && ++pfFails >= 6) {
            usePathfinder = false;
            this.log('pathfinder keeps failing (chunks not loaded or blocked) - switching to simple walking', 'warn');
          }
        }
        if (this.session !== id) break;
        try { b.swingArm('right'); } catch (_) {}
        await sleep(1500 + Math.random() * 4500 / (1 + shared.afkLevel));
      }
    })().catch(err => this.log('walk error: ' + err.message, 'warn'));
  }

  // Fallback walking without pathfinder: face the target, walk forward, jump when stuck.
  async walkSimple(b, id, t) {
    const release = () => { for (const k of ['forward', 'sprint', 'jump']) { try { b.setControlState(k, false); } catch (_) {} } };
    try {
      const p0 = b.entity.position;
      await b.lookAt(p0.offset(t.x - p0.x, 1.6, t.z - p0.z), true);
      b.setControlState('forward', true);
      const end = Date.now() + 8000;
      let last = b.entity.position.clone(), lastCheck = Date.now();
      while (Date.now() < end && this.session === id && b === this.bot && b.entity) {
        const p = b.entity.position;
        if (Math.hypot(p.x - t.x, p.z - t.z) < 2) break;
        if (Date.now() - lastCheck > 1000) {
          b.setControlState('jump', Math.hypot(p.x - last.x, p.z - last.z) < 0.3);
          last = p.clone(); lastCheck = Date.now();
        }
        await sleep(150);
      }
    } finally { release(); }
  }

  // ---------- connection ----------
  async start() {
    if (!this.active || shuttingDown) return;
    const token = ++this.startToken;
    if (S.PING_BEFORE_JOIN) {
      this.probing = true;
      let p;
      try { p = await probeServer(); } catch (_) { p = { state: 'unknown' }; }
      if (token !== this.startToken || !this.active || shuttingDown) return;
      this.probing = false;
      if (p.state === 'offline') {
        this.offlineStreak++;
        // Safety valve: every 5th check try a real join anyway (in case the ping check is wrong).
        if (this.offlineStreak % 5 !== 0) {
          if (this.offlineStreak === 1 || this.offlineStreak % 10 === 0) {
            const tip = /aternos/i.test(S.SERVER_IP)
              ? 'open your Aternos panel and press START (a bot cannot start Aternos by itself)'
              : 'start it from your host panel';
            this.log(`server is not answering${p.error ? ' (' + p.error + ')' : ''} - waiting, checking every ${S.OFFLINE_RETRY}s. ${tip}`, 'warn');
          }
          return this.scheduleRejoin(S.OFFLINE_RETRY, 'server offline');
        }
      } else {
        if (this.offlineStreak > 0) this.log(`server answers now${p.version ? ' (' + p.version + ')' : ''} - joining`, 'info');
        this.offlineStreak = 0;
      }
    }
    this.connect();
  }

  connect() {
    if (!this.active || shuttingDown) return;
    this.attempts++;
    this.joinedAt = 0;
    this.online = false;
    this.settled = false;
    this.lastKick = '';
    const ladder = getLadder();
    const ver = S.VERSION || shared.goodVersion || ladder[shared.ladderPos] || false;
    this.lastVer = ver;
    const pr = probe.result || {};
    if (pr.version) this.log(`server reports "${pr.version}"${pr.protocol ? ' (protocol ' + pr.protocol + ')' : ''}`);
    if (pr.protocol && !shared.newerNoted && !libKnowsProtocol(pr.protocol)) {
      shared.newerNoted = true;
      this.log(`server speaks protocol ${pr.protocol}, newer than this bot library (supports up to ${mineflayer.latestSupportedVersion || '?'}) - the bot joins through ViaBackwards on the server using an older version`, 'warn');
    }
    this.log(`connecting to ${S.SERVER_IP}:${S.SERVER_PORT} as ${this.name} (version ${ver || 'auto'}) try #${this.attempts}`);
    let b;
    try {
      b = mineflayer.createBot({
        host: S.SERVER_IP, port: S.SERVER_PORT, username: this.name, version: ver, auth: 'offline',
        checkTimeoutInterval: 120000, // laggy servers won't cause false "timed out"
        connectTimeout: 30000,
        viewDistance: 'tiny' // small view = less data + CPU (walking hops are only 10-30 blocks)
      });
    } catch (err) {
      this.log('create failed: ' + err.message, 'error');
      this.failsInRow++;
      return this.scheduleRejoin(retryPlan(err.message, this.failsInRow).wait, 'create failed');
    }
    this.bot = b;
    const id = this.session;
    let ready = false;
    let lastPacket = Date.now();
    let stage = 'none'; // none -> tcp (connected) -> login (login packet received) -> spawn

    guardPackets(b, this.name);
    b.loadPlugin(pathfinder);

    // TCP keep-alive + "last data seen" tracking (detects half-dead connections).
    b._client.once('connect', () => {
      if (stage === 'none') stage = 'tcp';
      try { b._client.socket.setKeepAlive(true, 15000); b._client.socket.setNoDelay(true); } catch (_) {}
    });
    b._client.on('packet', () => { lastPacket = Date.now(); });

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

    b.once('login', () => { stage = 'login'; });
    const stuck = early => {
      if (this.joinedAt || b !== this.bot) return;
      const serverUp = (probe.result && probe.result.state) === 'online';
      if (early && !(stage === 'tcp' && serverUp)) return; // early check only for "connected but silent"
      const why = stage === 'login' ? 'logged in but never spawned (world still loading)'
        : stage === 'tcp' ? 'connected, but the server never finished the login (version mismatch, or server still starting)'
        : 'no answer from the server (offline, still starting, or wrong IP / port)';
      this.log(`join stuck at stage "${stage}": ${why}`, 'warn');
      if (stage !== 'none' || serverUp) advanceLadder(this.name, ver, 'join hung');
      this.handleEnd(b, `join timeout ${early ? S.JOIN_HANG_SECONDS : S.JOIN_TIMEOUT}s`);
    };
    if (S.JOIN_HANG_SECONDS > 0 && S.JOIN_HANG_SECONDS < S.JOIN_TIMEOUT) this.timers.push(setTimeout(() => stuck(true), S.JOIN_HANG_SECONDS * 1000));
    this.timers.push(setTimeout(() => stuck(false), S.JOIN_TIMEOUT * 1000));

    b.once('spawn', () => {
      if (b !== this.bot) return; // this bot was switched off while it was still joining
      this.joinedAt = Date.now(); this.failsInRow = 0; this.online = true;
      lastPacket = Date.now();
      if (!S.VERSION) { shared.goodVersion = b.version; shared.ladderPos = 0; shared.tried.clear(); } // remember what worked
      this.log(`joined server (version ${b.version})`, 'join');
      this.timers.push(setTimeout(() => { ready = true; }, 4000));

      // Dead-connection detector: the server normally sends data every few seconds.
      if (S.STALE_TIMEOUT > 0) {
        this.timers.push(setInterval(() => {
          const idle = Date.now() - lastPacket;
          if (idle > S.STALE_TIMEOUT * 1000) {
            this.log(`no data from server for ${Math.round(idle / 1000)}s - reconnecting`, 'warn');
            this.handleEnd(b, 'stale connection (no data)');
          }
        }, 10000));
      }

      const spawnT = Date.now();
      const quietMs = (S.WALK_START_DELAY + shared.quietBoost) * 1000; // nothing moves before this
      this.log(`quiet time: no movement for ${Math.round(quietMs / 1000)}s after joining`);
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
        const at = Math.max(spawnT + quietMs, Date.now() + 3000);
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

      if (S.ANTI_AFK) {
        // Real activity (arm swing, head turn, jump, small step) so AFK plugins do not kick.
        // Starts only after the walk has started; never fights with the pathfinder.
        let nextAct = 0;
        this.timers.push(setInterval(() => {
          if (this.session !== id || b !== this.bot || !b.physicsEnabled || !b.entity) return;
          if (Date.now() < nextAct) return;
          nextAct = Date.now() + Math.max(5000, 14000 - shared.afkLevel * 3500) + Math.random() * 3000;
          try {
            const e = b.entity;
            b.swingArm('right');
            const moving = b.pathfinder && b.pathfinder.isMoving && b.pathfinder.isMoving();
            if (moving || !Number.isFinite(e.yaw)) return;
            const pr = b.look(e.yaw + (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 0.5, false);
            if (pr && pr.catch) pr.catch(() => {});
            if (shared.afkLevel >= 1 || Math.random() < 0.5) {
              b.setControlState('jump', true);
              setTimeout(() => { try { b.setControlState('jump', false); } catch (_) {} }, 250);
            }
            if (shared.afkLevel >= 2) {
              b.setControlState('forward', true);
              setTimeout(() => { try { b.setControlState('forward', false); } catch (_) {} }, 500);
            }
          } catch (_) {}
        }, 2500));
      }

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
    b.on('kicked', r => {
      if (b !== this.bot) return;
      this.lastKick = reasonText(r);
      this.log(`kicked: ${this.lastKick}`, 'kick');
    });
    b.on('error', err => {
      if (b !== this.bot) return;
      this.log(`${err.code ? err.code + ' ' : ''}${err.message}`, 'error');
      // Packet decode errors right after joining = the bot speaks a different version than the server.
      if (this.joinedAt && Date.now() - this.joinedAt < 30000 && VERSION_ERR.test(err.message)) {
        b._pktErr = (b._pktErr || 0) + 1;
        if (b._pktErr >= 3) { this.log('packet errors right after joining - the version does not match', 'warn'); this.handleEnd(b, 'invalid packets: ' + err.message); }
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
    log(`${w.name} ${state}${nxt} | switches done: ${this.switches} | server: ${(probe.result && probe.result.state) || 'unknown'}`, 'status');
  }

  snapshot() {
    const now = Date.now();
    const pr = probe.result || {};
    return {
      status: 'running',
      uptime: fmtDur(process.uptime() * 1000),
      server: {
        state: pr.state || 'unknown',
        version: pr.version || null,
        protocol: pr.protocol == null ? null : pr.protocol,
        players: pr.players == null ? null : pr.players,
        maxPlayers: pr.max == null ? null : pr.max
      },
      connection: {
        botVersion: shared.goodVersion || S.VERSION || null,
        ladder: (() => { const l = getLadder().map(v => v || 'auto'); return l.length > 6 ? [...l.slice(0, 6), `+${l.length - 6} more`] : l; })(),
        ladderPos: shared.ladderPos,
        afkLevel: shared.afkLevel,
        libraryMax: mineflayer.latestSupportedVersion || null
      },
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
        version: w.online && w.bot ? w.bot.version || null : null,
        tries: w.attempts
      }))
    };
  }
}

// ============================ STATUS PAGE ============================
// Optional. Open the Railway public URL to see which bot is on duty and when the next switch happens.
// It never shows the server IP or any password.
const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>GG BOT Console</title>
<style>
:root{--bg:#f3f5f9;--card:#ffffff;--text:#0f172a;--muted:#64748b;--line:#e2e8f0;--ok:#16a34a;--warn:#d97706;--bad:#dc2626;--accent:#6366f1;--accent2:#06b6d4;--shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0a0e14;--card:#121821;--text:#e6edf3;--muted:#8b98a9;--line:#212a37;--ok:#3fb950;--warn:#e3b341;--bad:#f85149;--accent:#818cf8;--accent2:#22d3ee;--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 28px rgba(0,0,0,.35)}}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Inter,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1000px;margin:0 auto;padding:20px 16px 44px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:12px}
.logo{width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;color:#fff;font-weight:800;font-size:14px;letter-spacing:.5px}
h1{font-size:18px;margin:0;line-height:1.2}
.sub{color:var(--muted);font-size:12.5px}
.pill{display:inline-flex;align-items:center;gap:8px;padding:7px 13px;border-radius:999px;background:var(--card);border:1px solid var(--line);font-size:13px;font-weight:600;box-shadow:var(--shadow)}
.dot{width:9px;height:9px;border-radius:50%;background:var(--muted)}
.dot.ok{background:var(--ok);animation:pulse 2s infinite}
.dot.warn{background:var(--warn)}
.dot.bad{background:var(--bad)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 0 0 8px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:12px;margin-bottom:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px 16px;box-shadow:var(--shadow)}
.k{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.v{font-size:19px;font-weight:700;margin-top:3px;word-break:break-word}
.s{color:var(--muted);font-size:12.5px;margin-top:2px;word-break:break-word}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);font-size:14px;white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em}
tr:last-child td{border-bottom:0}
.badge{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;color:#fff}
.b-on{background:var(--ok)}.b-wait{background:var(--warn)}.b-off{background:var(--muted)}
.duty{color:var(--accent);font-weight:700}
.term-card{padding:0;overflow:hidden;margin-top:14px}
.bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--line)}
.bar h2{font-size:14px;margin:0 auto 0 0;display:flex;align-items:center;gap:8px}
.cnt{color:var(--muted);font-size:12px;font-weight:500}
.chip{border:1px solid var(--line);background:transparent;color:var(--muted);padding:4px 11px;border-radius:999px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.chip.on{background:var(--accent);border-color:var(--accent);color:#fff}
.btn{border:1px solid var(--line);background:var(--card);color:var(--text);padding:5px 11px;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.btn:hover,.chip:hover{border-color:var(--accent)}
#term{height:min(60vh,460px);overflow:auto;background:#0b0f14;color:#d6deeb;font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:10px 12px;-webkit-overflow-scrolling:touch}
.ln{white-space:pre-wrap;word-break:break-word;padding:1px 0}
.ts{color:#5b6b7f;margin-right:8px}
.tg{display:inline-block;min-width:76px;margin-right:6px;font-weight:700;color:#64748b}
.who{color:#7aa2f7;margin-right:6px}
.k-chat .tg{color:#a5b4fc}
.k-join .tg,.k-player_join .tg{color:#4ade80}
.k-leave .tg,.k-player_leave .tg,.k-warn .tg{color:#fbbf24}
.k-kick .tg,.k-error .tg,.k-death .tg{color:#f87171}
.k-reconnect .tg{color:#fb923c}
.k-rotate .tg{color:#22d3ee}
.k-error .msg,.k-kick .msg{color:#fca5a5}
.k-warn .msg{color:#fde68a}
.k-move .msg,.k-status .msg{color:#8b98a9}
.foot{color:var(--muted);font-size:12px;margin-top:14px;text-align:center}
</style></head>
<body><main>
<header>
<div class="brand"><div class="logo">GG</div><div><h1>GG BOT Console</h1><div class="sub" id="sub">Loading...</div></div></div>
<div class="pill"><span class="dot" id="pdot"></span><span id="ptxt">Connecting</span></div>
</header>
<div class="grid">
<div class="card"><div class="k">On duty</div><div class="v" id="duty">-</div><div class="s" id="duty2">&nbsp;</div></div>
<div class="card"><div class="k">Next switch in</div><div class="v" id="next">-</div><div class="s" id="next2">&nbsp;</div></div>
<div class="card"><div class="k">Server</div><div class="v" id="srv">-</div><div class="s" id="srv2">&nbsp;</div></div>
<div class="card"><div class="k">Bot joins as</div><div class="v" id="ver">-</div><div class="s" id="ver2">&nbsp;</div></div>
</div>
<div class="card scroll"><table>
<thead><tr><th>Bot</th><th>State</th><th>Online for</th><th>Version</th><th>Tries</th></tr></thead>
<tbody id="rows"></tbody></table></div>
<div class="card term-card">
<div class="bar">
<h2>Live console <span class="cnt" id="cnt"></span></h2>
<button class="chip on" data-f="all">All</button>
<button class="chip" data-f="chat">Chat</button>
<button class="chip" data-f="players">Players</button>
<button class="chip" data-f="bots">Bots</button>
<button class="chip" data-f="problems">Problems</button>
<button class="btn" id="pause">Pause</button>
<button class="btn" id="clear">Clear</button>
<button class="btn" id="copy">Copy</button>
</div>
<div id="term"></div>
</div>
<div class="foot">Live updates. Status JSON: /api/status</div>
</main>
<script>
var GROUPS={chat:'chat',player_join:'players',player_leave:'players',warn:'problems',error:'problems',kick:'problems'};
var filter='all',paused=false,lastId=0,lines=[],MAX=800;
var term=document.getElementById('term');
function grp(k){return GROUPS[k]||'bots';}
function visible(l){return filter==='all'||grp(l.kind)===filter;}
function pad(n){return (n<10?'0':'')+n;}
function hhmmss(ms){var d=new Date(ms);return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function setText(id,t){document.getElementById(id).textContent=t;}
function mk(l){
  var d=el('div','ln k-'+l.kind);
  d.appendChild(el('span','ts',hhmmss(l.t)));
  d.appendChild(el('span','tg',l.tag));
  if(l.who)d.appendChild(el('span','who','['+l.who+']'));
  d.appendChild(el('span','msg',l.msg));
  return d;
}
function nearBottom(){return term.scrollHeight-term.scrollTop-term.clientHeight<70;}
function count(){var n=0;lines.forEach(function(l){if(visible(l))n++;});setText('cnt',n+' lines'+(paused?' (paused)':''));}
function renderAll(){
  term.textContent='';
  var f=document.createDocumentFragment();
  lines.forEach(function(l){if(visible(l))f.appendChild(mk(l));});
  term.appendChild(f);term.scrollTop=term.scrollHeight;count();
}
function append(items){
  var stick=nearBottom();
  items.forEach(function(l){lines.push(l);if(!paused&&visible(l))term.appendChild(mk(l));});
  if(lines.length>MAX+100){lines=lines.slice(-MAX);if(!paused)renderAll();}
  else if(!paused&&stick)term.scrollTop=term.scrollHeight;
  count();
}
function poll(){
  fetch('/api/logs?since='+lastId,{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(d.reset){lines=[];term.textContent='';}
    if(d.lines&&d.lines.length)append(d.lines);
    lastId=d.last;
  }).catch(function(){}).then(function(){setTimeout(poll,1500);});
}
var chips=document.querySelectorAll('.chip');
chips.forEach(function(c){c.addEventListener('click',function(){
  filter=c.getAttribute('data-f');
  chips.forEach(function(x){x.classList.toggle('on',x===c);});
  renderAll();
});});
var pb=document.getElementById('pause');
pb.addEventListener('click',function(){paused=!paused;pb.textContent=paused?'Resume':'Pause';if(!paused)renderAll();else count();});
document.getElementById('clear').addEventListener('click',function(){lines=[];term.textContent='';count();});
var cb=document.getElementById('copy');
cb.addEventListener('click',function(){
  var t=lines.filter(visible).map(function(l){return hhmmss(l.t)+' '+l.tag+(l.who?' ['+l.who+']':'')+' '+l.msg;}).join(String.fromCharCode(10));
  var done=function(){cb.textContent='Copied';setTimeout(function(){cb.textContent='Copy';},1200);};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,function(){});}
});
function setPill(cls,txt){document.getElementById('pdot').className='dot '+cls;setText('ptxt',txt);}
function render(d){
  var r=d.rotation,s=d.server||{},c=d.connection||{};
  var active=null;d.bots.forEach(function(b){if(b.name===r.activeBot)active=b;});
  var anyReady=d.bots.some(function(b){return b.online&&b.ready;});
  if(anyReady)setPill('ok','Bot online');
  else if(s.state==='offline')setPill('bad','Server offline');
  else setPill('warn','Connecting');
  setText('sub','Uptime '+d.uptime+' | switches done '+r.switchesDone);
  setText('duty',r.activeBot);
  setText('duty2',active&&active.online?'online for '+active.onlineFor:'not online yet');
  setText('next',r.enabled?r.nextSwitchIn:'Rotation off');
  setText('next2',r.enabled?'then '+r.nextBot:'only one bot runs');
  var srv=s.state==='online'?'Online':(s.state==='offline'?'Offline / starting':'Unknown');
  if(s.state==='online'&&s.players!==null)srv+=' ('+s.players+'/'+s.maxPlayers+')';
  setText('srv',srv);
  setText('srv2',s.version?'reports '+s.version+(s.protocol?' (protocol '+s.protocol+')':''):'no ping data yet');
  var cur=(active&&active.version)||c.botVersion;
  setText('ver',cur?cur:'auto detect');
  setText('ver2','tries: '+(c.ladder||[]).join(' > ')+(c.libraryMax?' | library max '+c.libraryMax:''));
  var body=document.getElementById('rows');body.textContent='';
  d.bots.forEach(function(b){
    var tr=el('tr');
    tr.appendChild(el('td',b.name===r.activeBot?'duty':'',b.name));
    var st=el('td'),label,cls;
    if(b.online&&b.ready){label='Online';cls='b-on';}
    else if(b.online){label='Logging in';cls='b-wait';}
    else if(b.active){label='Connecting';cls='b-wait';}
    else{label='Standby';cls='b-off';}
    st.appendChild(el('span','badge '+cls,label));
    tr.appendChild(st);
    tr.appendChild(el('td','',b.onlineFor||'-'));
    tr.appendChild(el('td','',b.version||'-'));
    tr.appendChild(el('td','',String(b.tries)));
    body.appendChild(tr);
  });
}
function load(){
  fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json();}).then(render)
  .catch(function(){setPill('bad','Dashboard offline');});
}
load();setInterval(load,4000);poll();
</script></body></html>`;

// Optional password for the dashboard (DASHBOARD_PASSWORD). /health stays open for Railway.
function authorized(req) {
  if (!S.DASHBOARD_PASSWORD) return true;
  const h = String(req.headers.authorization || '');
  if (!h.startsWith('Basic ')) return false;
  const given = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = Buffer.from(given.slice(given.indexOf(':') + 1));
  const want = Buffer.from(String(S.DASHBOARD_PASSWORD));
  return pass.length === want.length && crypto.timingSafeEqual(pass, want);
}

let statusServer = null;
function startStatusPage(rot) {
  if (!S.STATUS_PAGE) return;
  const port = Number(process.env.PORT) || S.STATUS_PORT;
  statusServer = http.createServer((req, res) => {
    try {
      const u = new URL(req.url || '/', 'http://localhost');
      const url = u.pathname;
      if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
      if (!authorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GG BOT", charset="UTF-8"', 'Content-Type': 'text/plain' });
        return res.end('Login required');
      }
      const json = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
      if (url === '/api/status' || url === '/status') {
        res.writeHead(200, json);
        return res.end(JSON.stringify(rot.snapshot(), null, 2));
      }
      if (url === '/api/logs') {
        let since = Number(u.searchParams.get('since')) || 0;
        let reset = false;
        if (since > consoleId) { since = 0; reset = true; } // bot restarted: send everything again
        let lines = consoleBuf.filter(l => l.id > since);
        if (lines.length > 400) lines = lines.slice(-400);
        res.writeHead(200, json);
        return res.end(JSON.stringify({ reset, last: consoleId, lines }));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(DASHBOARD_HTML);
    } catch (_) { try { res.writeHead(500); res.end('error'); } catch (_) {} }
  });
  statusServer.on('error', err => log('dashboard: ' + err.message, 'warn'));
  statusServer.listen(port, '0.0.0.0', () => log(`dashboard is on port ${port} (/ = live console, /api/status = json, /health = ok)${S.DASHBOARD_PASSWORD ? ' | password protected' : ' | public (set DASHBOARD_PASSWORD to protect it)'}`));
}

// ============================ RUN ============================
// If the program itself keeps hitting unexpected errors, exit so Railway restarts it cleanly.
const crashes = [];
function noteCrash(kind, err) {
  log(`${kind}: ${(err && err.message) || err}`, 'error');
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && now - crashes[0] > 300000) crashes.shift();
  if (crashes.length > 25 && !shuttingDown) {
    log('too many internal errors in 5 minutes - exiting so Railway restarts the bot', 'error');
    setTimeout(() => process.exit(1), 1500);
  }
}
process.on('uncaughtException', err => noteCrash('uncaught', err));
process.on('unhandledRejection', err => noteCrash('unhandled', err));

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

log(`started | bots ${S.BOT_NAMES.join(', ')} | ${S.ROTATE_HOURS}h each | walk ${S.RANDOM_WALK ? 'on' : 'off'} (${S.WALK_RADIUS} blocks) | chat ${S.CHAT_MESSAGES ? 'on' : 'off'} | stay ${S.STAY_MINUTES}min | discord ${S.DISCORD_WEBHOOK ? 'on' : 'off'}`);
log(`version mode: ${S.VERSION ? 'fixed ' + S.VERSION : 'smart (ping -> exact version -> all ' + VERS.all.length + ' versions ' + (VERS.all[0] || '?') + ' ... ' + (VERS.all[VERS.all.length - 1] || '?') + ')'} | mineflayer supports up to ${mineflayer.latestSupportedVersion || 'unknown'} | node ${process.version}`);
rotator.start();
startStatusPage(rotator);
