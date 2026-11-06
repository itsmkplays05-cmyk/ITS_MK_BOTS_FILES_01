const http = require('http');
const cfg = require('./config');
const log = require('./logger');
const botm = require('./bot');

const PAGE = `<!doctype html><html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Minecraft AFK Bot Panel</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,sans-serif;background:#0f1117;color:#e6e8ee;padding:14px;max-width:760px;margin:auto}
h1{font-size:20px;margin:6px 0 14px}.card{background:#181b24;border:1px solid #262b38;border-radius:12px;padding:14px;margin-bottom:14px}
.row{display:flex;gap:10px;flex-wrap:wrap}.stat{flex:1 1 120px;background:#11141b;border-radius:10px;padding:10px}
.stat b{display:block;font-size:12px;color:#8b93a7;font-weight:500}.stat span{font-size:16px}
button{border:0;border-radius:10px;padding:11px 16px;font-size:15px;color:#fff;cursor:pointer;flex:1}
.g{background:#1f9d55}.r{background:#d64545}.b{background:#2f6df6}
label{display:block;font-size:13px;color:#8b93a7;margin:10px 0 4px}
input,select{width:100%;padding:10px;border-radius:8px;border:1px solid #2a3040;background:#0f1117;color:#e6e8ee;font-size:15px}
pre{background:#0b0d12;border-radius:10px;padding:10px;height:260px;overflow:auto;font-size:12px;white-space:pre-wrap;margin:0}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:#777}.on{background:#2ecc71}.mid{background:#f1c40f}
</style></head><body>
<h1>Minecraft AFK Bot Panel</h1>
<div class="card"><div class="row">
<div class="stat"><b>Status</b><span id="st"><i class="dot"></i>...</span></div>
<div class="stat"><b>Uptime</b><span id="up">-</span></div>
<div class="stat"><b>Players</b><span id="pl">-</span></div>
<div class="stat"><b>Position</b><span id="po">-</span></div></div>
<div class="row" style="margin-top:12px"><button class="g" onclick="act('start')">Start</button>
<button class="r" onclick="act('stop')">Stop</button><button class="b" onclick="act('restart')">Restart</button></div></div>
<div class="card"><b>Settings</b>
<label>Server IP</label><input id="host"><label>Port</label><input id="port" type="number">
<label>Bot Name</label><input id="username"><label>Bot Password</label><input id="password">
<label>Version (khali = auto)</label><input id="version" placeholder="auto">
<label>Radius (block)</label><input id="radius" type="number">
<label>Random Movement</label><select id="move"><option value="true">ON</option><option value="false">OFF</option></select>
<label>Circle Mode</label><select id="circle"><option value="false">OFF</option><option value="true">ON</option></select>
<label>Resource Pack Download</label><select id="rpDownload"><option value="true">ON</option><option value="false">OFF</option></select>
<label>Leave &amp; Rejoin (minute, 0 = off)</label><input id="leaveRejoinMinutes" type="number">
<div class="row" style="margin-top:14px"><button class="b" onclick="save()">Save &amp; Restart</button></div></div>
<div class="card"><b>Live Logs</b><pre id="logs" style="margin-top:10px"></pre></div>
<script>
const $=id=>document.getElementById(id);let filled=false;
const fmt=s=>{const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h+'h '+m+'m '+(s%60)+'s'};
async function api(p,o){const r=await fetch(p,o);return r.json()}
async function poll(){try{const d=await api('/api/state');
const c=d.status==='online'?'on':(d.status==='stopped'?'':'mid');
$('st').innerHTML='<i class="dot '+c+'"></i>'+d.status;$('up').textContent=d.uptime?fmt(d.uptime):'-';
$('pl').textContent=d.players||'-';$('po').textContent=d.pos?d.pos.join(', '):'-';
const L=$('logs'),bottom=L.scrollTop+L.clientHeight>=L.scrollHeight-20;L.textContent=d.logs.join('\\n');if(bottom)L.scrollTop=L.scrollHeight;
if(!filled){for(const k in d.settings)$(k).value=d.settings[k];filled=true}}catch(e){}}
async function act(a){await api('/api/action',{method:'POST',body:JSON.stringify({action:a})});poll()}
async function save(){const s={};['host','port','username','password','version','radius','move','circle','rpDownload','leaveRejoinMinutes'].forEach(k=>s[k]=$(k).value);
await api('/api/settings',{method:'POST',body:JSON.stringify(s)});alert('Saved! Bot restart ho raha hai.');poll()}
poll();setInterval(poll,3000);
</script></body></html>`;

function authed(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return pass === cfg.panelPassword;
}

function body(req) {
  return new Promise((res) => {
    let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
  });
}

function startPanel() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') { res.end('ok'); return; } // Railway health check
    if (!authed(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Bot Panel"' }); res.end('Login required'); return;
    }
    const json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/api/state') return json({ ...botm.state(), logs: log.lines(), settings: cfg.flat() });
    if (req.url === '/api/action' && req.method === 'POST') {
      const { action } = await body(req);
      if (action === 'start') botm.restart(); else if (action === 'stop') botm.stop(); else if (action === 'restart') botm.restart();
      return json({ ok: true });
    }
    if (req.url === '/api/settings' && req.method === 'POST') {
      cfg.apply(await body(req)); cfg.save(); botm.restart(); return json({ ok: true });
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(PAGE);
  });
  server.listen(process.env.PORT || 3000, () => log.info('Panel ready on port ' + (process.env.PORT || 3000)));
}

module.exports = startPanel;
