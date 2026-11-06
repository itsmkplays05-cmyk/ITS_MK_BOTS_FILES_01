const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const out = (lvl, args) => console.log(`[${stamp()}] [${lvl}]`, ...args);
module.exports = {
  info: (...a) => out('INFO', a),
  warn: (...a) => out('WARN', a),
  error: (...a) => out('ERROR', a)
};
