const buf = [];
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const out = (lvl, args) => {
  const line = `[${stamp()}] [${lvl}] ` + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  buf.push(line);
  if (buf.length > 200) buf.shift();
};
module.exports = {
  info: (...a) => out('INFO', a),
  warn: (...a) => out('WARN', a),
  error: (...a) => out('ERROR', a),
  lines: () => buf.slice()
};
