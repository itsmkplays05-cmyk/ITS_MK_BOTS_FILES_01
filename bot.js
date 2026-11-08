const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const cfg = require('./settings.json');
const e = process.env;

const host = e.MC_HOST || cfg.host;
const port = Number(e.MC_PORT || cfg.port);
const username = e.BOT_USERNAME || cfg.username;
const version = e.MC_VERSION || cfg.version || false; // false = auto-detect server version
const authPassword = e.BOT_PASSWORD || cfg.authPassword;

const log = m => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let bot = null;
let timers = [];
let retrying = false;
let plannedLeave = false;
let session = 0; // changes on every (re)connect so old loops stop

function clear() {
  session++;
  timers.forEach(t => { clearInterval(t); clearTimeout(t); });
  timers = [];
}

function retry(delay) {
  if (retrying) return;
  retrying = true;
  clear();
  const d = delay || cfg.reconnectDelay;
  log(`Rejoining in ${d / 1000}s...`);
  setTimeout(() => { retrying = false; start(); }, d);
}

// Safety net: never send a broken (NaN / out of range) movement packet.
// This is what causes "Invalid move player packet received".
function guardPackets(b) {
  const c = b._client;
  const orig = c.write.bind(c);
  const moveNames = new Set(['position', 'position_look', 'look', 'flying', 'vehicle_move', 'move_vehicle']);
  let blocked = 0;
  c.write = (name, params) => {
    if (moveNames.has(name) && params) {
      for (const k of ['x', 'y', 'z']) {
        if (k in params && (!Number.isFinite(params[k]) || Math.abs(params[k]) > 2.9e7)) {
          if (++blocked % 20 === 1) log(`Blocked invalid ${name} packet (${k}=${params[k]})`);
          return;
        }
      }
      for (const k of ['yaw', 'pitch']) {
        if (k in params && !Number.isFinite(params[k])) return;
      }
      if ('pitch' in params) params.pitch = Math.max(-90, Math.min(90, params.pitch));
    }
    return orig(name, params);
  };
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); })
  ]).finally(() => clearTimeout(t));
}

function startRoaming(b, id) {
  const spawn = b.entity.position.clone();
  const R = cfg.roamRadius;
  const mcData = require('minecraft-data')(b.version);
  const mv = new Movements(b, mcData);
  mv.canDig = false;
  mv.allowParkour = false;
  mv.allow1by1towers = false;
  b.pathfinder.setMovements(mv);
  b.pathfinder.thinkTimeout = 4000;
  log(`Roaming within ${R} blocks of spawn (${spawn.x.toFixed(1)}, ${spawn.y.toFixed(1)}, ${spawn.z.toFixed(1)})`);

  (async () => {
    while (session === id && b.entity) {
      try {
        const p = b.entity.position;
        let tx = p.x + (Math.random() * 2 - 1) * 30;
        let tz = p.z + (Math.random() * 2 - 1) * 30;
        const dx = tx - spawn.x, dz = tz - spawn.z, dist = Math.hypot(dx, dz);
        if (dist > R) { tx = spawn.x + (dx / dist) * R; tz = spawn.z + (dz / dist) * R; }
        await withTimeout(b.pathfinder.goto(new goals.GoalNearXZ(tx, tz, 2)), 20000);
      } catch (_) {
        try { b.pathfinder.stop(); } catch (_) {}
      }
      if (session !== id) break;
      try { b.swingArm('right'); } catch (_) {}
      await sleep(2000 + Math.random() * 6000);
    }
  })().catch(err => log('Roam error: ' + err.message));
}

function start() {
  log(`Connecting to ${host}:${port} as ${username} (version: ${version || 'auto'})`);
  try {
    bot = mineflayer.createBot({ host, port, username, version, auth: cfg.auth });
  } catch (err) { log('Create error: ' + err.message); return retry(); }

  const b = bot;
  const id = session;
  guardPackets(b);
  b.loadPlugin(pathfinder);
  b.physicsEnabled = false; // frozen until world + position are ready
  if (b.physics) b.physics.enabled = false;

  b.once('spawn', () => {
    log(`Bot joined the server (version ${b.version})`);

    // login first, so the server doesn't block/teleport us back
    if (authPassword) {
      timers.push(setTimeout(() => {
        b.chat(`/register ${authPassword} ${authPassword}`);
        b.chat(`/login ${authPassword}`);
        log('Login commands sent');
      }, 1500));
    }

    // start moving only after the world is loaded
    timers.push(setTimeout(() => {
      if (!b.entity || !Number.isFinite(b.entity.position.x) || !Number.isFinite(b.entity.position.y)) {
        log('Bad spawn position, rejoining');
        return b.quit();
      }
      b.physicsEnabled = true;
      if (b.physics) b.physics.enabled = true;
      log('Movement enabled');
      if (cfg.roam) startRoaming(b, id);
    }, cfg.moveDelay));

    // chat messages
    if (cfg.chatRepeat && cfg.messages.length) {
      let i = 0;
      timers.push(setInterval(() => {
        b.chat(cfg.messages[i]);
        i = (i + 1) % cfg.messages.length;
      }, cfg.chatDelay * 1000));
    }

    // timed leave and rejoin
    timers.push(setTimeout(() => {
      log(`${cfg.sessionMinutes} min done - leaving, rejoining after ${cfg.leaveWait / 1000}s`);
      plannedLeave = true;
      b.quit();
    }, cfg.sessionMinutes * 60 * 1000));
  });

  b.on('chat', (u, m) => { if (u !== b.username) log(`<${u}> ${m}`); });
  b.on('death', () => log('Bot died, respawning'));
  b.on('kicked', r => log('Kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r))));
  b.on('error', err => log('Error: ' + err.message));
  b.on('end', () => {
    if (b !== bot) return;
    if (plannedLeave) { plannedLeave = false; log('Left server'); retry(cfg.leaveWait); }
    else { log('Disconnected/kicked'); retry(cfg.reconnectDelay); }
  });
}

process.on('uncaughtException', err => log('Uncaught: ' + err.message));
process.on('unhandledRejection', err => log('Unhandled: ' + (err && err.message || err)));
start();
