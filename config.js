// =====================================================
//  SIRF YE 5 LINE BADLO (baaki sab panel se hota hai)
// =====================================================
const SERVER_IP      = 'yourserver.aternos.me';  // server ka address
const SERVER_PORT    = 25565;                    // port (Aternos me aksar 25565)
const BOT_NAME       = 'AFK_Bot';                // bot ka naam
const PASSWORD       = 'BotPass123';             // bot ka login/register password
const PANEL_PASSWORD = 'admin123';               // panel kholne ka password (zarur badlo)

// =====================================================
//  NEECHE KUCH MAT BADLO
// =====================================================
const fs = require('fs');
const FILE = './settings.json';
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const cfg = {
  host: env('MC_HOST', SERVER_IP),
  port: parseInt(env('MC_PORT', SERVER_PORT)),
  username: env('MC_USERNAME', BOT_NAME),
  password: env('MC_PASSWORD', PASSWORD),
  panelPassword: env('PANEL_PASSWORD', PANEL_PASSWORD),
  auth: 'offline',
  version: env('MC_VERSION', ''),
  movement: { enabled: true, radius: 100, circle: false, minDelay: 6000, maxDelay: 18000 },
  resourcePack: { download: true, timeoutMs: 20000, dir: './packs' },
  leaveRejoinMinutes: 0,
  reconnect: { minDelay: 5000, maxDelay: 120000 }
};

cfg.flat = () => ({
  host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, version: cfg.version,
  radius: cfg.movement.radius, move: cfg.movement.enabled, circle: cfg.movement.circle,
  rpDownload: cfg.resourcePack.download, leaveRejoinMinutes: cfg.leaveRejoinMinutes
});

cfg.apply = (p) => {
  if (p.host !== undefined) cfg.host = String(p.host).trim();
  if (p.port !== undefined) cfg.port = parseInt(p.port) || 25565;
  if (p.username !== undefined) cfg.username = String(p.username).trim();
  if (p.password !== undefined) cfg.password = String(p.password);
  if (p.version !== undefined) cfg.version = String(p.version).trim();
  if (p.radius !== undefined) cfg.movement.radius = Math.max(5, Math.min(1000, parseInt(p.radius) || 100));
  if (p.move !== undefined) cfg.movement.enabled = p.move === true || p.move === 'true';
  if (p.circle !== undefined) cfg.movement.circle = p.circle === true || p.circle === 'true';
  if (p.rpDownload !== undefined) cfg.resourcePack.download = p.rpDownload === true || p.rpDownload === 'true';
  if (p.leaveRejoinMinutes !== undefined) cfg.leaveRejoinMinutes = Math.max(0, parseInt(p.leaveRejoinMinutes) || 0);
};

cfg.save = () => { try { fs.writeFileSync(FILE, JSON.stringify(cfg.flat(), null, 2)); } catch {} };
try { cfg.apply(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}

module.exports = cfg;
