const http = require('http');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const cfg = require('./config');
const log = require('./logger');
const resourcePack = require('./resourcePack');
const movement = require('./movement');
const leaveRejoin = require('./leaveRejoin');
const auth = require('./auth');

let status = 'starting', attempts = 0, shuttingDown = false, current = null;

// Railway health check (PORT env Railway deta hai)
http.createServer((_, res) => { res.end(`bot: ${status}`); })
  .listen(process.env.PORT || 3000, () => log.info('Health server ready'));

function schedule() {
  if (shuttingDown) return;
  const d = Math.min(cfg.reconnect.minDelay * 2 ** attempts, cfg.reconnect.maxDelay);
  attempts++;
  status = `reconnecting in ${Math.round(d / 1000)}s`;
  log.info(status);
  setTimeout(start, d);
}

function start() {
  const opts = { host: cfg.host, port: cfg.port, username: cfg.username, auth: cfg.auth, hideErrors: true, checkTimeoutInterval: 60000 };
  if (cfg.version) opts.version = cfg.version; // warna auto-detect
  log.info(`Connecting ${cfg.host}:${cfg.port} as ${cfg.username} (version: ${cfg.version || 'auto'})`);

  let bot;
  try { bot = mineflayer.createBot(opts); } catch (e) { log.error(e.message); return schedule(); }
  current = bot;
  bot.loadPlugin(pathfinder);

  resourcePack(bot, cfg);
  auth(bot, cfg);
  const stopMove = movement(bot, cfg);
  const stopLR = leaveRejoin(bot, cfg);

  let ended = false;
  const onEnd = (why) => {
    if (ended) return; ended = true;
    stopMove(); stopLR();
    status = 'disconnected';
    log.warn('Disconnected:', why);
    schedule();
  };

  bot.once('spawn', () => { attempts = 0; status = 'online'; log.info('Joined server'); });
  bot.on('kicked', (r) => log.warn('Kicked:', typeof r === 'string' ? r : JSON.stringify(r)));
  bot.on('error', (e) => log.warn('Error:', e.message));
  bot.on('end', onEnd);
}

const stop = () => { shuttingDown = true; try { current && current.quit(); } catch {} setTimeout(() => process.exit(0), 500); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
process.on('uncaughtException', (e) => log.error('uncaught:', e.message));
process.on('unhandledRejection', (e) => log.error('unhandled:', e && e.message));

start();
