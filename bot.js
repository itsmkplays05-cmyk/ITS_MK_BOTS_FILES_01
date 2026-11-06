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

function retry() {
  if (retrying) return;
  retrying = true;
  clear();
  log(`Reconnecting in ${cfg.reconnectDelay / 1000}s...`);
  setTimeout(() => { retrying = false; start(); }, cfg.reconnectDelay);
}

function start() {
  log(`Connecting to ${host}:${port} as ${username} (version: ${version || 'auto'})`);
  try {
    bot = mineflayer.createBot({ host, port, username, version, auth: cfg.auth });
  } catch (err) { log('Create error: ' + err.message); return retry(); }

  bot.once('spawn', () => {
    log('Bot joined the server');
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
    if (cfg.antiAfk) {
      timers.push(setInterval(() => {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
      }, 20000));
    }
  });

  bot.on('chat', (u, m) => { if (u !== bot.username) log(`<${u}> ${m}`); });
  bot.on('kicked', r => log('Kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r))));
  bot.on('error', err => log('Error: ' + err.message));
  bot.on('end', () => { log('Disconnected'); retry(); });
}

process.on('uncaughtException', err => log('Uncaught: ' + err.message));
process.on('unhandledRejection', err => log('Unhandled: ' + (err && err.message || err)));
start();
