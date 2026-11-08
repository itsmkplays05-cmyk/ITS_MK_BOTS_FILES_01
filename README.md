# GG BOT v7 - 3 Bot Rotation (Railway)

Ek hi Minecraft server (Aternos) par **3 bots baari-baari se** AFK rehte hain:

```
ITS_GG_BOT  ->  ITS_GG_02  ->  ITS_GG_03  ->  ITS_GG_BOT  ->  ...  (loop, hamesha)
   3 ghante        3 ghante       3 ghante        3 ghante
```

- Ek time par ek hi bot "on duty" hota hai.
- 3 ghante poore hote hi **agla bot pehle join karta hai**, login hone ke baad ~10 sec saath rehte hain, phir purana bot nikal jata hai. Isse server kabhi khali nahi hota.
- Agar agla bot join na kar paye (whitelist, naam ka issue, etc.) to purana bot server mein **rukta hai** aur teesre bot ko try kiya jata hai. Sab fail ho to 5 minute baad dobara try.
- Join / login / random walk / anti-AFK / 30 min leave-rejoin ka logic purane bot jaisa hi hai. Har bot apne turn ke andar wahi karta hai.

## Files

| File | Kaam |
|---|---|
| `bot.js` | Poora bot + rotation |
| `settings.txt` | Saari settings (naam, IP, port, password, rotation, ...) |
| `package.json` | Libraries + Node 22 (mineflayer ko Node 22+ chahiye) |
| `.gitignore` | `node_modules` GitHub par nahi jayega |

## 1) GitHub par daalo

1. github.com par **New repository** banao (naam: `gg-bot`). Repo ko **Private** rakho, kyunki `settings.txt` mein password / webhook hota hai.
2. Zip ko **extract** karo. Andar ki saari files (`bot.js`, `package.json`, `settings.txt`, ...) repo mein **seedhe** upload karo (**Add file -> Upload files**). Koi extra folder nahi, `package.json` repo ke sabse upar (root) mein dikhna chahiye.
3. **Commit changes** dabao.

## 2) Railway par deploy

1. railway.com -> **New Project -> Deploy from GitHub repo** -> apna `gg-bot` repo chuno.
2. Build apne aap hoga (Node + `npm install`). 1-2 minute baad **Deployments -> View Logs** kholo.
3. Logs mein ye dikhna chahiye:
   ```
   ROTATE rotation ON: ITS_GG_BOT -> ITS_GG_02 -> ITS_GG_03 -> (repeat) | 3 hour(s) per bot | next switch at 18:40:12
   INFO [ITS_GG_BOT] connecting to ITS-FRIEND-ONLY-SMP.aternos.me:37984 ...
   JOIN [ITS_GG_BOT] joined server (version 1.21.x)
   ```
4. Replicas **1** hi rehne do (2 kar diye to ek hi naam ke 2 bot ban jayenge).
5. (Optional, behtar) Service **Settings -> Deploy -> Custom Start Command** mein likho: `node bot.js`. Isse redeploy par bot sahi se quit karta hai.

Settings badalni ho to GitHub par `settings.txt` edit karo, Railway apne aap redeploy kar dega. Ya Railway ke **Variables** tab mein same naam se variable daalo (jaise `ROTATE_HOURS = 2`), wo `settings.txt` se upar chalta hai.

## 3) Server side checklist (zaroori)

- Agar server par **whitelist ON** hai to `ITS_GG_02` aur `ITS_GG_03` ko whitelist karo, warna wo join nahi honge (bot 1 ruka rahega, rotation nahi hoga).
- Login plugin (AuthMe) ho to naye bots pehli baar khud `/register` kar lete hain (settings wala `LOGIN_PASSWORD`). Agar plugin ek IP se kam accounts allow karta hai to limit badha do.
- Agar server ek IP se 2 account same time par allow nahi karta to `SEAMLESS_SWITCH = off` kar do (purana pehle nikalega, phir naya aayega, ~5 sec ka gap).

## Settings (settings.txt)

| Setting | Matlab | Default |
|---|---|---|
| `BOT_NAME`, `BOT_NAME_2`, `BOT_NAME_3` | Bots ke naam, isi order mein rotation. `BOT_NAME_4` ... `BOT_NAME_10` se aur bots jodo | ITS_GG_BOT / ITS_GG_02 / ITS_GG_03 |
| `ROTATE_HOURS` | Ek bot kitne ghante (decimal chalega, 0 = rotation band) | 3 |
| `SEAMLESS_SWITCH` | on = naya pehle join, purana baad mein | on |
| `HANDOVER_OVERLAP` | Switch ke time dono kitne sec saath | 10 |
| `HANDOVER_TIMEOUT` | Naye bot ko join hone ke liye kitne sec | 120 |
| `SWITCH_RETRY_MINUTES` | Switch fail ho to dobara try | 5 |
| `STATUS_LOG_MINUTES` | Logs mein status line har itne minute (0 = off) | 10 |
| `STATUS_PAGE` | Chhota status page (on/off) | on |
| `STAY_MINUTES`, `LEAVE_WAIT`, `REJOIN_WAIT` | Har bot apne turn mein itne minute rukkar 10 sec ke liye nikalta hai (0 = kabhi nahi) | 30 / 10 / 3 |
| baaki | `SERVER_IP`, `SERVER_PORT`, `LOGIN_PASSWORD`, `RANDOM_WALK`, `ANTI_AFK`, `CHAT_*`, `DISCORD_*` | pehle jaisa |

## Status page (optional)

Railway mein service ke **Settings -> Networking -> Generate Domain** karo. Us link par jaoge to dikhega kaun sa bot on duty hai, agla switch kab hai. `/health` par `ok` aata hai. Page par server IP ya password nahi dikhta. Nahi chahiye to `STATUS_PAGE = off`.

## Logs kaise padhein

```
ROTATE time is up for ITS_GG_BOT -> switching to ITS_GG_02 (new bot joins first, old bot leaves after)
JOIN   [ITS_GG_02] joined server
LEAVE  [ITS_GG_BOT] stopping (rotation)
ROTATE switch done: ITS_GG_02 is on duty now | next: ITS_GG_03 at 21:40:12
STATUS ITS_GG_02 online for 1h 3m 4s | next switch -> ITS_GG_03 in 1h 56m 56s (at 21:40:12)
```

## Problem aaye to

| Dikha | Karo |
|---|---|
| `ITS_GG_02 could not join ... ITS_GG_BOT stays` | Whitelist / naam / login ka issue. Pehle `kicked:` wali line padho, wahi wajah hai |
| `ECONNREFUSED` / `could not join` baar baar | Aternos server band hai, pehle server start karo. Bots khud reconnect karte rahenge |
| `settings: ... must be a number` | `settings.txt` mein us line ki value theek karo |
| Build fail | `package.json` repo ke root mein hona chahiye, folder ke andar nahi |
| Do same naam ke bot dikh rahe | Railway par replicas 1 rakho, purana deployment band hone do |
