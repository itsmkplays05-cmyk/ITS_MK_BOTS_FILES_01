// ===== SETTINGS (Railway par Variables se bhi change ho jati hain) =====
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const bool = (v) => String(v).toLowerCase() === 'true';

module.exports = {
  host: env('MC_HOST', 'yourserver.aternos.me'),
  port: parseInt(env('MC_PORT', '25565')),
  username: env('MC_USERNAME', 'AFK_Bot'),
  auth: env('MC_AUTH', 'offline'),          // offline (cracked) ya microsoft
  version: env('MC_VERSION', ''),           // khali = server ka version auto-detect (sab versions)

  password: env('MC_PASSWORD', 'BotPass123'), // AuthMe /register aur /login ke liye

  movement: {
    enabled: bool(env('MOVE', 'true')),     // random movement ON
    radius: parseInt(env('RADIUS', '100')), // spawn point se max 100 block
    circle: bool(env('CIRCLE', 'false')),   // circle mode OFF
    minDelay: 6000,
    maxDelay: 18000
  },

  resourcePack: {
    download: bool(env('RP_DOWNLOAD', 'true')), // server pack ho to download karke accept
    timeoutMs: 20000,
    dir: './packs'
  },

  leaveRejoinMinutes: parseInt(env('LEAVE_REJOIN_MIN', '0')), // 0 = off

  reconnect: { minDelay: 5000, maxDelay: 120000 }
};
