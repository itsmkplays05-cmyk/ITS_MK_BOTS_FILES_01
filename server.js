const express = require('express');
const path = require('path');
const bm = require('./botManager');

const app = express();
const PORT = process.env.PORT || 3000;
const KEY = process.env.PANEL_PASSWORD || '';
app.use(express.json());

app.get('/health', (_, res) => res.send('ok'));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/icon.png', (_, res) => res.sendFile(path.join(__dirname, 'icon.png')));

const auth = (req, res, next) => {
  if (!KEY) return next();
  if ((req.headers['x-panel-key'] || req.query.key) === KEY) return next();
  res.status(401).json({ error: 'Wrong password' });
};

app.get('/api/status', auth, (_, res) => res.json({ ...bm.getStatus(), protected: !!KEY }));
app.get('/api/auth-required', (_, res) => res.json({ required: !!KEY }));

app.post('/api/command', auth, (req, res) => {
  try { bm.exec(req.body.cmd, req.body.args); res.json({ ok: true }); }
  catch (e) { bm.log(e.message, 'error'); res.status(400).json({ error: e.message }); }
});

// Live console stream (Server-Sent Events)
app.get('/api/stream', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  send('history', bm.logs);
  send('status', bm.getStatus());
  const onLog = l => send('log', l), onStatus = s => send('status', s), onClear = () => send('history', []);
  bm.on('log', onLog); bm.on('status', onStatus); bm.on('clear', onClear);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => { clearInterval(ping); bm.off('log', onLog); bm.off('status', onStatus); bm.off('clear', onClear); });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Panel running on port ${PORT}`);
  if (!KEY) console.log('WARNING: PANEL_PASSWORD not set - panel is public!');
  bm.start();
});

process.on('uncaughtException', e => bm.log('Uncaught: ' + e.message, 'error'));
process.on('unhandledRejection', e => bm.log('Unhandled: ' + (e && e.message || e), 'error'));
