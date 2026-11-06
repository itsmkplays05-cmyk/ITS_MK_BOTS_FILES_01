const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const cfg = require('./config');
const log = require('./logger');
const resourcePack = require('./resourcePack');
const movement = require('./movement');
const leaveRejoin = require('./leaveRejoin');
const auth = require('./auth');

let bot = null, timer = null, wanted = true, attempts = 0, status = 'stopped', since = null;

function schedule() {
  if (!wanted) return;
  const d = Math.min(cfg.reconnect.minDelay * 2 ** attempts, cfg.reconnect.maxDelay);
  attempts++;
  status = `reconnecting (${Math.round(d / 1000)}s)`;
  log.info(status);
  timer = setTimeout(start, d);
}

function start() {
  clearTimeout(timer);
  if (!wanted || bot) return;
  status = 'connecting';
  const opts = { host: cfg.host, port: cfg.port, username: cfg.username, auth: cfg.auth, hideErrors: true, checkTimeoutInterval: 60000 };
  if (cfg.version) opts.version = cfg.version;
  log.info(`Connecting ${cfg.host}:${cfg.port} as ${cfg.username} (version: ${cfg.version || 'auto'})`);

  let b;
  try { b = mineflayer.createBot(opts); } catch (e) { log.error(e.message); return schedule(); }
  bot = b;
  b.loadPlugin(pathfinder);
  resourcePack(b, cfg); auth(b, cfg);
  const stopMove = movement(b, cfg), stopLR = leaveRejoin(b, cfg);

  let ended = false;
  b.once('spawn', () => { attempts = 0; status = 'online'; since = Date.now(); log.info('Joined server'); });
  b.on('kicked', (r) => log.warn('Kicked:', r));
  b.on('error', (e) => log.warn('Error:', e.message));
  b.on('end', (why) => {
    if (ended) return; ended = true;
    stopMove(); stopLR();
    if (bot === b) bot = null;
    since = null;
    log.warn('Disconnected:', why);
    if (wanted) schedule(); else status = 'stopped';
  });
}

function stop() {
  wanted = false; clearTimeout(timer);
  if (bot) { try { bot.quit(); } catch {} }
  status = 'stopped'; since = null; log.info('Bot stopped');
}

function restart() {
  log.info('Restarting bot');
  wanted = false; clearTimeout(timer);
  const old = bot;
  if (old) { try { old.quit(); } catch {} }
  setTimeout(() => { bot = null; wanted = true; attempts = 0; start(); }, 1500);
}

function state() {
  let players = 0, pos = null;
  try { if (bot && bot.players) players = Object.keys(bot.players).length; if (bot && bot.entity) { const p = bot.entity.position; pos = [Math.round(p.x), Math.round(p.y), Math.round(p.z)]; } } catch {}
  return { status, uptime: since ? Math.floor((Date.now() - since) / 1000) : 0, players, pos };
}

module.exports = { start, stop, restart, state };
