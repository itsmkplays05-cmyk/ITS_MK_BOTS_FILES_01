const { Movements, goals } = require('mineflayer-pathfinder');
const log = require('./logger');

module.exports = function movement(bot, cfg) {
  const m = cfg.movement;
  if (!m.enabled) return () => {};
  let origin = null, timer = null, angle = 0, stopped = false;

  const rand = (a, b) => a + Math.random() * (b - a);

  function step() {
    if (stopped || !bot.entity) return;
    try {
      const p = bot.entity.position;
      let tx, tz;
      if (m.circle) {
        angle += Math.PI / 6;
        const r = Math.min(8, m.radius);
        tx = origin.x + Math.cos(angle) * r; tz = origin.z + Math.sin(angle) * r;
      } else {
        // abhi ki position se 10-30 block door, lekin spawn se radius ke andar
        const a = rand(0, Math.PI * 2), d = rand(10, 30);
        tx = p.x + Math.cos(a) * d; tz = p.z + Math.sin(a) * d;
        const dx = tx - origin.x, dz = tz - origin.z, dist = Math.hypot(dx, dz);
        if (dist > m.radius) { tx = origin.x + dx / dist * m.radius; tz = origin.z + dz / dist * m.radius; }
      }
      bot.pathfinder.setGoal(new goals.GoalNearXZ(Math.floor(tx), Math.floor(tz), 2));
      if (Math.random() < 0.4) bot.setControlState('jump', true), setTimeout(() => bot.setControlState('jump', false), 300);
    } catch (e) { log.warn('move error:', e.message); }
    timer = setTimeout(step, rand(m.minDelay, m.maxDelay));
  }

  bot.once('spawn', () => {
    origin = bot.entity.position.clone();
    const mv = new Movements(bot);
    mv.canDig = false; mv.allowSprinting = false;
    bot.pathfinder.setMovements(mv);
    bot.pathfinder.thinkTimeout = 3000;
    timer = setTimeout(step, 5000);
  });

  return () => { stopped = true; clearTimeout(timer); };
};
