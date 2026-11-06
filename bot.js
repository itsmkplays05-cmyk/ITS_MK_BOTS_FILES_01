const mineflayer = require('mineflayer');
const cfg = require('./settings.json');
const e = process.env;

const host = e.MC_HOST || cfg.host;
const port = Number(e.MC_PORT || cfg.port);
const username = e.BOT_USERNAME || cfg.username;
const version = e.MC_VERSION || cfg.version || false; // false = auto-detect latest/server version

let bot, timers = [], retrying = false;
const clear = () => { timers.forEach(t => { clearInterval(t); clearTimeout(t); }); timers = []; };
const log = m => console.log(`[${new Date().toISOString()}] ${m}`);

let plannedLeave = false;
function retry(delay) {
  if (retrying) return;
  retrying = true;
  clear();
  const d = delay || cfg.reconnectDelay;
  log(`Rejoining in ${d / 1000}s...`);
  setTimeout(() => { retrying = false; start(); }, d);
}

function start() {
  log(`Connecting to ${host}:${port} as ${username} (version: ${version || 'auto'})`);
  try {
    bot = mineflayer.createBot({ host, port, username, version, auth: cfg.auth });
  } catch (err) { log('Create error: ' + err.message); return retry(); }

  bot.physicsEnabled = false; // no move packets until chunks are loaded
  if (bot.physics) bot.physics.enabled = false;

  bot.once('spawn', () => {
    log('Bot joined the server');
    timers.push(setTimeout(() => {
      log(`${cfg.sessionMinutes} min done - leaving, will rejoin after ${cfg.leaveWait / 1000}s`);
      plannedLeave = true;
      bot.quit();
    }, cfg.sessionMinutes * 60 * 1000));
    timers.push(setTimeout(() => {
      bot.physicsEnabled = true;
      if (bot.physics) bot.physics.enabled = true;
      log('Movement enabled');
      startRandomMove();
    }, 10000));
    if (cfg.authPassword) {
      timers.push(setTimeout(() => {
        bot.chat(`/register ${cfg.authPassword} ${cfg.authPassword}`);
        bot.chat(`/login ${cfg.authPassword}`);
      }, 1000));
    }
    if (cfg.chatRepeat && cfg.messages.length) {
      let i = 0;
      timers.push(setInterval(() => {
        bot.chat(cfg.messages[i]);
        i = (i + 1) % cfg.messages.length;
      }, cfg.chatDelay * 1000));
    }
  });

  function startRandomMove() {
    if (!cfg.antiAfk) return;
    const dirs = ['forward', 'back', 'left', 'right'];
    const step = () => {
      if (!bot || !bot.entity) return;
      try {
        bot.clearControlStates();
        bot.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6, true);
        const d = dirs[Math.floor(Math.random() * dirs.length)];
        bot.setControlState(d, true);
        if (Math.random() < 0.5) bot.setControlState('jump', true);
        timers.push(setTimeout(() => { try { bot.clearControlStates(); } catch (_) {} }, 400 + Math.random() * 1200));
      } catch (_) {}
      timers.push(setTimeout(step, 6000 + Math.random() * 9000));
    };
    step();
  }

  bot.on('chat', (u, m) => { if (u !== bot.username) log(`<${u}> ${m}`); });
  bot.on('kicked', r => log('Kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r))));
  bot.on('error', err => log('Error: ' + err.message));
  bot.on('end', () => {
    if (plannedLeave) { plannedLeave = false; log('Left server'); retry(cfg.leaveWait); }
    else { log('Disconnected/kicked'); retry(cfg.reconnectDelay); }
  });
}

process.on('uncaughtException', err => log('Uncaught: ' + err.message));
process.on('unhandledRejection', err => log('Unhandled: ' + (err && err.message || err)));
start();
