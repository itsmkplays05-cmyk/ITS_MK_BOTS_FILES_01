# AFK Bot

Start: `npm install` then `npm start`

## settings.json
- `server.ip` / `server.port` : server address
- `server.version` : `"auto"` = detect automatically (any version). Or type a version like `"1.21.4"`
- `bot-account.username` : bot name
- `utils.auto-auth.password` : password used for /register and /login
- `movement.random-walk` : bot roams randomly (`radius` = blocks around spawn, default 100)
- `movement.circle-walk.enabled` : circle mode (off by default)

Newer servers than the installed mineflayer supports: the bot joins with the newest supported version,
install ViaVersion + ViaBackwards on the server for this.
