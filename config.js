// =====================================================
//  SIRF YE 4 LINE BADLO (baaki sab pehle se set hai)
// =====================================================
const SERVER_IP   = 'yourserver.aternos.me';  // server ka address
const SERVER_PORT = 25565;                    // port (Aternos me aksar 25565)
const BOT_NAME    = 'AFK_Bot';                // bot ka naam
const PASSWORD    = 'BotPass123';             // login/register password

// =====================================================
//  NEECHE KUCH MAT BADLO (zarurat ho tabhi)
// =====================================================
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const bool = (v) => String(v).toLowerCase() === 'true';

module.exports = {
  host: env('MC_HOST', SERVER_IP),
  port: parseInt(env('MC_PORT', SERVER_PORT)),
  username: env('MC_USERNAME', BOT_NAME),
  password: env('MC_PASSWORD', PASSWORD),
  auth: 'offline',
  version: env('MC_VERSION', ''),   // khali = apne aap sahi version

  movement: { enabled: true, radius: 100, circle: false, minDelay: 6000, maxDelay: 18000 },
  resourcePack: { download: true, timeoutMs: 20000, dir: './packs' },
  leaveRejoinMinutes: 0,
  reconnect: { minDelay: 5000, maxDelay: 120000 }
};
