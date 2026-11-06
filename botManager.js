const EventEmitter = require('events');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');

const cfgPath = path.join(__dirname, 'settings.json');
const strip = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

class BotManager extends EventEmitter {
  constructor() {
    super();
    this.config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const e = process.env;
    const c = this.config;
    if (e.MC_HOST) c.server.ip = e.MC_HOST;
    if (e.MC_PORT) c.server.port = Number(e.MC_PORT);
    if (e.MC_VERSION) c.server.version = e.MC_VERSION;
    if (e.BOT_USERNAME) c['bot-account'].username = e.BOT_USERNAME;
    if (e.BOT_AUTH) c['bot-account'].type = e.BOT_AUTH;
    if (e.BOT_PASSWORD) c['bot-account'].password = e.BOT_PASSWORD;
    this.logs = [];
    this.bot = null;
    this.status = 'offline';
    this.timers = [];
    this.manualStop = false;
    this.antiAfk = c.utils['anti-afk'].enabled;
  }

  log(msg, level = 'info') {
    const entry = { t: Date.now(), level, msg: strip(msg) };
    this.logs.push(entry);
    if (this.logs.length > 500) this.logs.shift();
    console.log(`[${level}] ${entry.msg}`);
    this.emit('log', entry);
  }

  setStatus(s) { this.status = s; this.emit('status', this.getStatus()); }

  getStatus() {
    const b = this.bot;
    const online = this.status === 'online' && b && b.entity;
    return {
      status: this.status,
      server: `${this.config.server.ip}:${this.config.server.port}`,
      version: this.config.server.version,
      username: this.config['bot-account'].username,
      antiAfk: this.antiAfk,
      health: online ? b.health : null,
      food: online ? b.food : null,
      position: online ? ['x', 'y', 'z'].map(k => Math.round(b.entity.position[k])) : null,
      players: online ? Object.keys(b.players) : []
    };
  }

  clearTimers() { this.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); this.timers = []; }

  start() {
    if (this.bot) return this.log('Bot already running', 'warn');
    this.manualStop = false;
    const c = this.config, u = c.utils;
    this.setStatus('connecting');
    this.log(`Connecting to ${c.server.ip}:${c.server.port} as ${c['bot-account'].username}...`);

    let bot;
    try {
      bot = mineflayer.createBot({
        username: c['bot-account'].username,
        password: c['bot-account'].password || undefined,
        auth: c['bot-account'].type === 'mojang' ? 'offline' : c['bot-account'].type,
        host: c.server.ip,
        port: c.server.port,
        version: c.server.version || false
      });
    } catch (err) {
      this.log('Create error: ' + err.message, 'error');
      this.setStatus('offline');
      return this.scheduleReconnect();
    }
    this.bot = bot;
    bot.loadPlugin(pathfinder);

    bot.once('spawn', () => {
      this.log('Bot joined the server', 'success');
      this.setStatus('online');
      const mcData = require('minecraft-data')(bot.version);
      this.movements = new Movements(bot, mcData);
      bot.settings.colorsEnabled = false;

      if (u['auto-auth'].enabled) {
        const pw = u['auto-auth'].password;
        this.timers.push(setTimeout(() => {
          bot.chat(`/register ${pw} ${pw}`);
          bot.chat(`/login ${pw}`);
        }, 500));
        this.log('[Auth] Authentication commands executed');
      }

      const cm = u['chat-messages'];
      if (cm.enabled) {
        if (cm.repeat) {
          let i = 0;
          this.timers.push(setInterval(() => {
            if (!cm.messages.length) return;
            bot.chat(cm.messages[i]);
            i = (i + 1) % cm.messages.length;
          }, cm['repeat-delay'] * 1000));
        } else cm.messages.forEach(m => bot.chat(m));
      }

      if (c.position.enabled) this.goto(c.position.x, c.position.y, c.position.z);

      // anti-afk: random small actions (works even if toggled live)
      this.timers.push(setInterval(() => {
        if (!this.antiAfk || !bot.entity) return;
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 300);
        if (u['anti-afk'].sneak) bot.setControlState('sneak', true);
      }, 20000));
    });

    bot.on('goal_reached', () => this.log('Bot arrived at target location', 'success'));
    bot.on('chat', (user, msg) => { if (user !== bot.username) this.log(`<${user}> ${msg}`, 'chat'); });
    bot.on('playerJoined', p => this.log(`${p.username} joined`, 'chat'));
    bot.on('playerLeft', p => this.log(`${p.username} left`, 'chat'));
    bot.on('death', () => this.log('Bot died and respawned', 'warn'));
    bot.on('health', () => this.emit('status', this.getStatus()));
    bot.on('kicked', r => this.log('Kicked: ' + (typeof r === 'string' ? r : JSON.stringify(r)), 'warn'));
    bot.on('error', e => this.log('Error: ' + e.message, 'error'));
    bot.on('end', () => {
      this.log('Disconnected', 'warn');
      this.clearTimers();
      this.bot = null;
      this.setStatus('offline');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.manualStop || !this.config.utils['auto-reconnect']) return;
    const d = this.config.utils['auto-reconnect-delay'] || 5000;
    this.log(`Reconnecting in ${d / 1000}s...`);
    this.timers.push(setTimeout(() => { if (!this.bot && !this.manualStop) this.start(); }, d));
  }

  stop() {
    this.manualStop = true;
    this.clearTimers();
    if (this.bot) { try { this.bot.quit(); } catch (_) {} this.bot = null; }
    this.setStatus('offline');
    this.log('Bot stopped by user');
  }

  restart() { this.stop(); setTimeout(() => this.start(), 1500); }

  need() { if (!this.bot || this.status !== 'online') throw new Error('Bot is not online'); return this.bot; }

  goto(x, y, z) {
    const b = this.need();
    b.pathfinder.setMovements(this.movements);
    b.pathfinder.setGoal(new goals.GoalBlock(x, y, z));
    this.log(`Moving to (${x}, ${y}, ${z})`);
  }

  // Run a panel command
  exec(cmd, args = {}) {
    switch (cmd) {
      case 'start': return this.start();
      case 'stop': return this.stop();
      case 'restart': return this.restart();
      case 'say': { const b = this.need(); const m = String(args.text || '').slice(0, 256); if (!m) throw new Error('Empty message'); b.chat(m); return this.log('> ' + m, 'sent'); }
      case 'jump': { const b = this.need(); b.setControlState('jump', true); setTimeout(() => b.setControlState('jump', false), 300); return this.log('Jumped'); }
      case 'sneak': { const b = this.need(); this.sneaking = !this.sneaking; b.setControlState('sneak', this.sneaking); return this.log('Sneak ' + (this.sneaking ? 'ON' : 'OFF')); }
      case 'forward': { const b = this.need(); b.setControlState('forward', true); setTimeout(() => b.setControlState('forward', false), 1000); return this.log('Walked forward'); }
      case 'back': { const b = this.need(); b.setControlState('back', true); setTimeout(() => b.setControlState('back', false), 1000); return this.log('Walked back'); }
      case 'goto': { const [x, y, z] = ['x', 'y', 'z'].map(k => Number(args[k])); if ([x, y, z].some(Number.isNaN)) throw new Error('Invalid coords'); return this.goto(x, y, z); }
      case 'stopmove': { const b = this.need(); b.pathfinder.setGoal(null); b.clearControlStates(); return this.log('Movement stopped'); }
      case 'antiafk': this.antiAfk = !this.antiAfk; this.emit('status', this.getStatus()); return this.log('Anti-AFK ' + (this.antiAfk ? 'ON' : 'OFF'));
      case 'clear': this.logs = []; return this.emit('clear');
      default: throw new Error('Unknown command: ' + cmd);
    }
  }
}
module.exports = new BotManager();
