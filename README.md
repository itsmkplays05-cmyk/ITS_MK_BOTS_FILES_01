# GG BOT v8

Minecraft AFK bot jo **Railway** par 24/7 chalta hai. Ek hi server par **3 bots baari-baari se** on duty rehte hain, har bot khud join, login, random walk aur reconnect karta hai.

```
ITS_GG_01  ->  ITS_GG_02  ->  ITS_GG_03  ->  ITS_GG_01  ->  ...   (loop, hamesha)
  3 ghante       3 ghante       3 ghante       3 ghante
```

## Features

| Feature | Detail |
|---|---|
| Bot rotation | 3 ghante baad agla bot **pehle join** karta hai, phir purana nikalta hai. Server kabhi khali nahi hota |
| Auto version detect | Server ka version bot khud pehchanta hai. Kuch likhna nahi padta (`SERVER_VERSION = auto`) |
| Connection fix | Reconnect delay 5s, 10s, 20s tak badhta hai. Kick ki wajah padhkar sahi time wait karta hai (throttle, whitelist, ban, full) |
| Dead connection detect | Server se 75 sec data na aaye to bot khud reconnect kar leta hai |
| Server offline check | Aternos band ya starting ho to bot chup-chaap wait karta hai aur server on hote hi join ho jata hai |
| Random walk | Spawn point se maximum **100 block** ke andar idhar-udhar ghumta hai, circle walk nahi |
| Auto login | `/login` aur `/register` apne aap (`LOGIN_PASSWORD`) |
| Dashboard | Railway ka public URL kholo, live status dikhega (kaun on duty, agla switch kab, server online hai ya nahi) |
| Discord logs | Optional, webhook daalo |

## Files (sab root mein, koi folder nahi)

| File | Kaam |
|---|---|
| `bot.js` | Poora bot, rotation aur dashboard |
| `settings.txt` | Saari settings (naam, IP, port, password, rotation ...) |
| `package.json` | Libraries aur Node 22 |
| `railway.json` | Railway start command aur auto-restart |
| `README.md` | Ye guide |

## Step 1: GitHub par upload

1. github.com par **New repository** banao (naam: `gg-bot`). Repo ko **Private** rakho, kyunki `settings.txt` mein password hota hai.
2. Repo mein **Add file -> Upload files** dabao.
3. Ye 5 files daalo: `bot.js`, `settings.txt`, `package.json`, `railway.json`, `README.md`. Zip chahiye to pehle **extract** karo, GitHub zip ko khud nahi kholta.
4. `package.json` repo ke sabse upar (root) mein dikhna chahiye, kisi folder ke andar nahi.
5. **Commit changes** dabao.

**Upload nahi ho raha to:**
- Phone browser mein menu se **Desktop site** ON karo, phir Upload files kholo.
- Ek saath nahi ho raha to files **ek-ek karke** upload karo (har baar Commit).
- Phir bhi na chale to **Add file -> Create new file** kholo, file ka naam likho (jaise `bot.js`) aur uska poora content paste karo.
- `.gitignore` ki zaroorat nahi hai, uske bina bhi sab chalega.

## Step 2: Railway par deploy

1. railway.com -> **New Project -> Deploy from GitHub repo** -> `gg-bot` chuno.
2. Build apne aap hoga. 1-2 minute baad **Deployments -> View Logs** kholo.
3. Logs mein ye dikhna chahiye:
   ```
   INFO started | bots ITS_GG_01, ITS_GG_02, ITS_GG_03 | 3h each | walk on (100 blocks) ...
   INFO version mode: auto-detect | mineflayer supports up to ...
   INFO [ITS_GG_01] connecting to ITS-FRIEND-ONLY-SMP.aternos.me:37984 ...
   JOIN [ITS_GG_01] joined server (version ...)
   ```
4. **Replicas 1** hi rehne do. 2 kar diye to ek hi naam ke 2 bot ban jayenge.
5. Dashboard chahiye to **Settings -> Networking -> Generate Domain** karo.

Settings badalni ho to GitHub par `settings.txt` edit karo, Railway apne aap redeploy karega. Ya Railway **Variables** mein same naam se variable daalo (jaise `ROTATE_HOURS = 2`), wo `settings.txt` se upar chalta hai.

## Join nahi ho raha? Pehle ye dekho (Aternos)

Bot sirf tab join kar sakta hai jab server **ON** ho. Aternos server ko bot khud start nahi kar sakta, aur Aternos khali server ko takriban 1 minute baad band kar deta hai.

1. Aternos panel kholo, server ko **Start** karo, jab tak status **Online** (green) na ho.
2. Panel mein dikha address aur port `SERVER_IP` / `SERVER_PORT` se match karo. Port badal gaya ho to `settings.txt` mein theek karo.
3. Server online hote hi bot 15 sec ke andar khud join ho jata hai. Kuch aur karne ki zaroorat nahi.

Logs ye batate hain:

| Log line | Matlab |
|---|---|
| `server is not answering ... press START` | Server band ya starting hai. Panel se start karo |
| `server answers now - joining` | Server on ho gaya, bot join kar raha hai |
| `join stuck at stage "none"` | Server se koi jawab nahi aaya (band, starting, ya IP/port galat) |
| `join stuck at stage "tcp"` | Server se judaa par login poora nahi hua (server abhi load ho raha hai) |
| `join stuck at stage "login"` | Login hua par world load nahi hua |

## Server side checklist

- **Whitelist ON** hai to `ITS_GG_02` aur `ITS_GG_03` ko bhi whitelist karo, warna rotation nahi hoga (bot 1 ruka rahega).
- Login plugin (AuthMe) ho to naye bots pehli baar khud `/register` kar lete hain. Agar plugin ek IP se kam accounts allow karta hai to limit badha do.
- Server ek IP se 2 account same time par allow nahi karta to `SEAMLESS_SWITCH = off` kar do.

## Supported versions (1.x se 26.x tak)

Bot version **auto detect** karta hai, lekin bot jis library (mineflayer) par chalta hai wahi decide karti hai ki kaun se version join ho sakte hain. Startup logs ki 2nd line mein dikhta hai:

```
version mode: auto-detect | mineflayer supports up to 26.1
```

- Purane versions se lekar library ke "supports up to" tak sab **auto** join hote hain.
- Agar server usse naye version par hai (jaise 26.2 / 26.3 aur library abhi us tak nahi pahunchi), to logs mein `version mismatch` aur ek hint aayegi. Tab 3 raaste hain:
  1. Server par **ViaVersion + ViaBackwards** plugin lagao (Aternos par Paper/Spigot ke saath plugin chalta hai). Phir bot purane version se join karke bhi naye server mein chal jata hai.
  2. Server ka version Aternos panel se bot ke supported version par rakho.
  3. Kuch din baad Railway par **Redeploy** karo. `package.json` mein `^` range hai, to har naye build par mineflayer ka latest version aata hai. Build cache ki wajah se purana aaye to `package.json` ka `version` number badha do aur commit karo.

## Settings (settings.txt)

| Setting | Matlab | Default |
|---|---|---|
| `BOT_NAME`, `BOT_NAME_2`, `BOT_NAME_3` | Bots ke naam, isi order mein rotation. `BOT_NAME_4` ... `BOT_NAME_10` se aur bots jodo | ITS_GG_01 / 02 / 03 |
| `SERVER_IP`, `SERVER_PORT` | Server ka address | Aternos wala |
| `SERVER_VERSION` | `auto` ya fixed version (jaise `1.21.4`, `26.1`) | auto |
| `LOGIN_PASSWORD` | `/login` aur `/register` ka password | 2345678 |
| `ROTATE_HOURS` | Ek bot kitne ghante (0 = rotation band) | 3 |
| `SEAMLESS_SWITCH` | on = naya pehle join, purana baad mein | on |
| `HANDOVER_OVERLAP` | Switch ke time dono kitne sec saath | 10 |
| `HANDOVER_TIMEOUT` | Naye bot ko join hone ke liye kitne sec | 120 |
| `RANDOM_WALK`, `WALK_RADIUS` | Random walk on/off aur max kitne block door | on / 100 |
| `ANTI_AFK` | Haath hilana aur sir ghumana | on |
| `CHAT_MESSAGES` | Auto chat messages | off |
| `STAY_MINUTES`, `LEAVE_WAIT` | Itne minute baad bot 10 sec ke liye nikalkar wapas aata hai (0 = kabhi nahi) | 30 / 10 |
| `REJOIN_WAIT`, `REJOIN_MAX` | Reconnect delay shuruat aur maximum (seconds) | 5 / 20 |
| `JOIN_TIMEOUT` | Join attempt ka time limit (seconds) | 60 |
| `STALE_TIMEOUT` | Itne sec data na aaye to reconnect (0 = off) | 75 |
| `PING_BEFORE_JOIN` | Join se pehle check ki server on hai | on |
| `OFFLINE_RETRY` | Server band ho to kitne sec baad dobara check | 15 |
| `STATUS_PAGE` | Dashboard on/off | on |
| `DISCORD_*` | Discord webhook aur kya bhejna hai | webhook khali |

## Logs kaise padhein

```
ROTATE time is up for ITS_GG_01 -> switching to ITS_GG_02 (new bot joins first, old bot leaves after)
JOIN   [ITS_GG_02] joined server (version 1.21.x)
LEAVE  [ITS_GG_01] stopping (rotation)
ROTATE switch done: ITS_GG_02 is on duty now | next: ITS_GG_03 at 21:40:12
STATUS ITS_GG_02 online for 1h 3m 4s | next switch -> ITS_GG_03 in 1h 56m 56s
```

## Problem aaye to

| Logs mein dikha | Karo |
|---|---|
| `server is offline or starting - waiting` | Aternos panel se server start karo. Bot khud join ho jayega |
| `server is throttling fast reconnects` | Kuch nahi, bot khud zyada wait karke dobara try karta hai |
| `bot name is not whitelisted` | Us naam ko whitelist karo |
| `bot name is BANNED` | Naam unban karo ya `settings.txt` mein naam badlo |
| `same name is still online` | Purana deployment band hone do, Replicas 1 rakho |
| `no data from server ... reconnecting` | Normal self-heal hai. Baar baar aaye to `STALE_TIMEOUT` 120 kar do |
| `version mismatch` / `unsupported protocol version` | Upar "Supported versions" section dekho |
| `settings: ... must be a number` | `settings.txt` mein us line ki value theek karo |
| Build fail | `package.json` repo ke root mein hona chahiye, folder ke andar nahi |
| `ITS_GG_02 could not join ... ITS_GG_01 stays` | Whitelist / naam / login ka issue. Pehle `kicked:` wali line padho |
