const log = require('./logger');
// AuthMe: server /register ya /login maange to automatic bhejta hai
module.exports = function auth(bot, cfg) {
  let done = false;
  bot.on('messagestr', (msg) => {
    const m = msg.toLowerCase();
    if (done) return;
    if (m.includes('/register')) { bot.chat(`/register ${cfg.password} ${cfg.password}`); log.info('Register bheja'); }
    else if (m.includes('/login')) { bot.chat(`/login ${cfg.password}`); log.info('Login bheja'); }
    else if (m.includes('successfully') && (m.includes('login') || m.includes('register'))) done = true;
  });
  bot.on('spawn', () => { done = false; });
};
