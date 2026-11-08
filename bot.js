const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ============================ SETTINGS READER (settings.txt) ============================
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  BOT_NAME: 'GG_BOT',
  SERVER_IP: 'localhost',
  SERVER_PORT: 25565,
  SERVER_VERSION: 'auto',
  LOGIN_PASSWORD: '',
  RANDOM_WALK: true,
  WALK_RADIUS: 100,
  WALK_START_DELAY: 10,
  ANTI_AFK: true,
  CHAT_MESSAGES: true,
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
const ON = ['on', 'true', 'yes', 'y', '1', 'haan', 'ha'];
const OFF = ['off', 'false', 'no', 'n', '0', 'nahi', 'band'];

function load(file = path.join(__dirname, 'settings.txt'), env = process.env) {
  const S = { ...DEFAULTS, MESSAGE: [] };
  const warnings = [];

  const apply = (key, val, where) => {
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') {
      const v = val.toLowerCase();
      if (ON.includes(v)) S[key] = true;
      else if (OFF.includes(v)) S[key] = false;
      else warnings.push(`${where}: ${key} ke liye "on" ya "off" likho (mila: "${val}")`);
    } else if (typeof def === 'number') {
      const n = Number(val);
      if (val !== '' && Number.isFinite(n) && n >= 0) S[key] = n;
      else warnings.push(`${where}: ${key} ke liye number likho (mila: "${val}")`);
    } else S[key] = val;
  };

  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (_) { warnings.push('settings.txt file nahi mili - default settings use ho rahi hain'); }

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 1) { warnings.push(`Line ${i + 1}: "=" nahi mila, ye line ignore ki`); return; }
    const key = line.slice(0, eq).trim().toUpperCase().replace(/\s+/g, '_');
    const val = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
    if (key === 'MESSAGE') { if (val) S.MESSAGE.push(val); return; }
    if (!(key in DEFAULTS)) { warnings.push(`Line ${i + 1}: "${key}" naam galat hai, ignore ki`); return; }
    apply(key, val, `Line ${i + 1}`);
  });

  // Railway Variables override the file (same names)
  for (const key of Object.keys(DEFAULTS)) {
    if (env[key] !== undefined && env[key] !== '') apply(key, String(env[key]).trim(), 'Railway Variable');
  }

  S.VERSION = /^(auto|latest|)$/i.test(S.SERVER_VERSION) ? false : S.SERVER_VERSION;
  S.SERVER_PORT = Math.floor(S.SERVER_PORT) || 25565;
  return { S, warnings };
}


const { S, warnings } = load();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================ LOGGING + DISCORD ============================
const ICON = {
  info: 'ℹ️', chat: '💬', join: '✅', leave: '🚪', kick: '🥾', error: '❌',
  warn: '⚠️', move: '🚶', player_join: '🟢', player_leave: '🔴', reconnect: '🔄', death: '💀'
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
      if (!r.ok) console.log(`[Discord] webhook error ${r.status} (URL check karo)`);
      return;
    } catch (err) { await sleep(2000); }
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
  const line = `[${stamp()}] ${ICON[kind] || ''} ${msg}`;
  console.log(line);
  if (allowedOnDiscord(kind)) toDiscord(line);
}

// ============================ HELPERS ============================
function reasonText(r) {
  try {
    if (r == null) return '';
    if (typeof r === 'string') {
      try { return reasonText(JSON.parse(r)); } catch (_) { return r; }
    }
    if (typeof r === 'object') {
      let out = '';
      if (r.text) out += r.text;
      if (r.translate) out += r.translate;
      if (r.value !== undefined) out += reasonText(r.value);
      if (Array.isArray(r.extra)) out += r.extra.map(reasonText).join('');
      if (Array.isArray(r.with)) out += ' ' + r.with.map(reasonText).join(' ');
      return out || JSON.stringify(r).slice(0, 300);
    }
    return String(r);
  } catch (_) { return 'unknown'; }
}
function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(t));
}

// Blocks broken (NaN / out of range) movement packets = no "Invalid move player packet" kicks.
function guardPackets(b) {
  const c = b._client;
  const orig = c.write.bind(c);
  const names = new Set(['position', 'position_look', 'look', 'flying', 'vehicle_move', 'move_vehicle']);
  let blocked = 0;
  c.write = (name, params) => {
    if (names.has(name) && params) {
      for (const k of ['x', 'y', 'z']) {
        if (k in params && (!Number.isFinite(params[k]) || Math.abs(params[k]) > 2.9e7)) {
          if (++blocked % 20 === 1) log(`Kharab movement packet roka (${k}=${params[k]})`, 'warn');
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
let bot = null, timers = [], session = 0, retrying = false, plannedLeave = false;
let shuttingDown = false;
let joins = 0, failsInRow = 0, joinedAt = 0;

function clearAll() {
  session++;
  timers.forEach(t => { clearInterval(t); clearTimeout(t); });
  timers = [];
}

function scheduleRejoin(seconds, why) {
  if (retrying || shuttingDown) return;
  retrying = true;
  clearAll();
  log(`Reconnecting ${seconds}s mein... (${why})`, 'reconnect');
  setTimeout(() => { retrying = false; start(); }, seconds * 1000);
}

function handleEnd(b, why) {
  if (b !== bot || b._done) return;
  b._done = true;
  try { b.end(); } catch (_) {}
  const stayed = joinedAt ? Math.round((Date.now() - joinedAt) / 1000) : 0;
  if (plannedLeave) {
    plannedLeave = false;
    log(`Bot ne leave kiya, ${S.LEAVE_WAIT}s baad wapas aayega`, 'leave');
    return scheduleRejoin(S.LEAVE_WAIT, 'timed leave');
  }
  if (joinedAt) { failsInRow = 0; log(`Connection tut gaya (${why}) - server mein ${stayed}s raha`, 'leave'); }
  else { failsInRow++; log(`Join nahi ho paya (${why}) - server band ya busy ho sakta hai`, 'warn'); }
  joinedAt = 0;
  const extra = failsInRow > 2 ? Math.min((failsInRow - 2) * 5, 30) : 0; // server offline = thoda ruk ke try
  scheduleRejoin(S.REJOIN_WAIT + extra, why);
}

function startRoaming(b, id) {
  const spawn = b.entity.position.clone();
  const R = S.WALK_RADIUS;
  const mv = new Movements(b, require('minecraft-data')(b.version));
  mv.canDig = false; mv.allowParkour = false; mv.allow1by1towers = false;
  b.pathfinder.setMovements(mv);
  b.pathfinder.thinkTimeout = 4000;
  log(`Ghoomna shuru - spawn (${spawn.x.toFixed(0)}, ${spawn.y.toFixed(0)}, ${spawn.z.toFixed(0)}) se ${R} block radius`, 'move');

  (async () => {
    while (session === id && b.entity) {
      try {
        const p = b.entity.position;
        let tx = p.x + (Math.random() * 2 - 1) * 30;
        let tz = p.z + (Math.random() * 2 - 1) * 30;
        const dx = tx - spawn.x, dz = tz - spawn.z, d = Math.hypot(dx, dz);
        if (d > R) { tx = spawn.x + dx / d * R; tz = spawn.z + dz / d * R; }
        log(`Ja raha hai -> X ${tx.toFixed(0)}, Z ${tz.toFixed(0)}`, 'move');
        await withTimeout(b.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 2)), 20000);
      } catch (_) { try { b.pathfinder.stop(); } catch (_) {} }
      if (session !== id) break;
      try { b.swingArm('right'); } catch (_) {}
      await sleep(2000 + Math.random() * 6000);
    }
  })().catch(err => log('Ghoomne mein error: ' + err.message, 'warn'));
}

function start() {
  joins++;
  log(`Server se connect ho raha hai: ${S.SERVER_IP}:${S.SERVER_PORT} (naam: ${S.BOT_NAME}, version: ${S.VERSION || 'auto'}) [koshish #${joins}]`, 'info');
  let b;
  try {
    b = mineflayer.createBot({ host: S.SERVER_IP, port: S.SERVER_PORT, username: S.BOT_NAME, version: S.VERSION, auth: 'offline' });
  } catch (err) {
    log('Bot nahi ban paya: ' + err.message, 'error');
    return scheduleRejoin(S.REJOIN_WAIT + 5, 'create error');
  }
  bot = b;
  const id = session;
  let ready = false;

  guardPackets(b);
  b.loadPlugin(pathfinder);
  b.physicsEnabled = false;
  if (b.physics) b.physics.enabled = false;

  // join hi nahi hua to 60s baad dobara try
  timers.push(setTimeout(() => { if (!joinedAt) handleEnd(b, 'join timeout 60s'); }, 60000));

  b.once('spawn', () => {
    joinedAt = Date.now(); failsInRow = 0;
    log(`Bot server mein JOIN ho gaya (version ${b.version})`, 'join');
    timers.push(setTimeout(() => { ready = true; }, 4000));

    if (S.LOGIN_PASSWORD) {
      timers.push(setTimeout(() => {
        b.chat(`/register ${S.LOGIN_PASSWORD} ${S.LOGIN_PASSWORD}`);
        b.chat(`/login ${S.LOGIN_PASSWORD}`);
        log('Login command bheji', 'info');
      }, 1500));
    }

    timers.push(setTimeout(() => {
      if (!b.entity || !Number.isFinite(b.entity.position.x) || !Number.isFinite(b.entity.position.y)) {
        log('Spawn position kharab, rejoin kar raha hai', 'warn');
        return b.quit();
      }
      b.physicsEnabled = true;
      if (b.physics) b.physics.enabled = true;
      if (S.RANDOM_WALK) startRoaming(b, id);
    }, S.WALK_START_DELAY * 1000));

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
        log(`${S.STAY_MINUTES} minute poore - bot leave kar raha hai`, 'leave');
        plannedLeave = true;
        b.quit();
      }, S.STAY_MINUTES * 60 * 1000));
    }
  });

  b.on('messagestr', (msg, pos) => {
    if (pos === 'game_info' || !msg || !msg.trim()) return;
    log(msg, 'chat');
  });
  b.on('playerJoined', p => { if (ready && p.username !== b.username) log(`${p.username} server mein aaya`, 'player_join'); });
  b.on('playerLeft', p => { if (ready && p.username !== b.username) log(`${p.username} server se gaya`, 'player_leave'); });
  b.on('death', () => log('Bot mar gaya, respawn ho raha hai', 'death'));
  b.on('kicked', r => log(`KICK hua: ${reasonText(r)}`, 'kick'));
  b.on('error', err => {
    log(`Error: ${err.code ? err.code + ' - ' : ''}${err.message}`, 'error');
    // some join errors never fire "end", so make sure we still retry
    timers.push(setTimeout(() => { if (!joinedAt) handleEnd(b, 'error'); }, 3000));
  });
  b.on('end', reason => handleEnd(b, reason || 'connection end'));
}

// ============================ START ============================
process.on('uncaughtException', err => log('Uncaught: ' + err.message, 'error'));
process.on('unhandledRejection', err => log('Unhandled: ' + (err && err.message || err), 'error'));
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    shuttingDown = true;
    log('Railway bot ko band kar raha hai (restart/redeploy)', 'warn');
    try { if (bot) bot.quit(); } catch (_) {}
    await flush().catch(() => {});
    setTimeout(() => process.exit(0), 500);
  });
}

console.log('================ GG_BOT ================');
warnings.forEach(w => log('Settings: ' + w, 'warn'));
const onoff = v => (v ? 'ON' : 'OFF');
log(`Settings: Ghoomna ${onoff(S.RANDOM_WALK)} (${S.WALK_RADIUS} block) | Chat ${onoff(S.CHAT_MESSAGES)} | AFK ${onoff(S.ANTI_AFK)} | Stay ${S.STAY_MINUTES}min | Discord ${S.DISCORD_WEBHOOK ? 'ON' : 'OFF'}`, 'info');
start();
