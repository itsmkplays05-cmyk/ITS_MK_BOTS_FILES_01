const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

module.exports = function resourcePack(bot, cfg) {
  const rp = cfg.resourcePack;
  const accept = () => { try { bot.acceptResourcePack(); } catch (e) { log.warn('accept fail:', e.message); } };

  bot.on('resourcePack', async (url, hash) => {
    log.info('Server resource pack mila:', url);
    if (rp.download) {
      try {
        fs.mkdirSync(rp.dir, { recursive: true });
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), rp.timeoutMs);
        const res = await fetch(url, { signal: ctl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
        const name = (hash || sha1).toString().slice(0, 40) + '.zip';
        fs.writeFileSync(path.join(rp.dir, name), buf);
        log.info(`Pack download ho gaya (${(buf.length / 1048576).toFixed(1)} MB)`);
      } catch (e) {
        log.warn('Pack download fail, phir bhi accept kar raha hoon:', e.message);
      }
    }
    accept(); // accept karne par server kick nahi karta
  });
};
