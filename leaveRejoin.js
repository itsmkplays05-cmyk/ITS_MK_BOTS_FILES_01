const log = require('./logger');
// Har N minute par bot leave karke dobara join karta hai (0 = off)
module.exports = function leaveRejoin(bot, cfg) {
  if (!cfg.leaveRejoinMinutes) return () => {};
  const t = setInterval(() => { log.info('Leave & rejoin'); bot.quit('rejoin'); }, cfg.leaveRejoinMinutes * 60000);
  return () => clearInterval(t);
};
