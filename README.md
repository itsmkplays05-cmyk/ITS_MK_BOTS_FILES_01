# GG BOT v9

Minecraft AFK bot (Railway 24/7). Ek server par **3 bots baari-baari se** on duty rehte hain:
`ITS_GG_01 -> ITS_GG_02 -> ITS_GG_03 -> ...` (har bot 3 ghante, naya bot pehle join karta hai, phir purana nikalta hai, server kabhi khali nahi).

## v9 me kya naya hai

| Problem | Fix |
|---|---|
| Version match nahi hota tha, join nahi hota tha | **Smart join**: bot server ko ping karke exact version khud chunta hai. Na chale to **saare versions (1.8 se sabse naye tak) newest -> oldest** ek-ek karke try karta hai. Kick me "use 1.20.4" jaisa likha ho to seedha wahi version lagata hai. Jo chal jaye use yaad rakhta hai |
| Join hote hi invalid packet | Join ke baad **10 second tak bot bilkul shaant** rehta hai (koi movement packet nahi). Phir hi walk shuru. "Invalid packet / bad packet / partial packet" error aaye to bot samajh jata hai ki version galat hai aur agla version lagata hai |
| 100 block walk | Spawn se maximum **100 block** ke andar, 10-30 block ke chhote hops. Kinare par pahunchne par spawn ki taraf wapas aata hai, circle walk nahi. Pathfinder halka (kam CPU), view distance chhota, sprint band |
| Aternos kick / server band | Arm swing + sir ghumana + jump + chhote step. AFK kick mile to bot khud aur zyada move karta hai. Reconnect me throttle / whitelist / ban ke hisaab se sahi wait. `STAY_MINUTES = 0` (bot beech me nikalta tha to server khali ho jata tha) |

## Deploy

1. GitHub repo (Private) me ye 5 files daalo (zip pehle extract karo): `bot.js`, `settings.txt`, `package.json`, `railway.json`, `README.md`.
2. Railway -> New Project -> Deploy from GitHub repo. **Replicas 1** rakho.
3. Logs me ye dikhna chahiye:
```
INFO version mode: smart (ping -> exact version -> all N versions ...)
INFO [ITS_GG_01] server reports "Paper 1.21.x" (protocol ...)
INFO [ITS_GG_01] connecting ... (version 1.21.x) try #1
JOIN [ITS_GG_01] joined server (version 1.21.x)
INFO [ITS_GG_01] quiet time: no movement for 10s after joining
MOVE [ITS_GG_01] walking within 100 blocks of spawn ...
```
4. Dashboard: Settings -> Networking -> Generate Domain.

Settings badalni ho to `settings.txt` edit karo (ya Railway Variables me same naam se variable daalo).

## Zaroori baatein (Aternos)

- Bot tabhi join kar sakta hai jab server **ON** ho. Aternos panel se Start karo, bot khud join ho jata hai.
- Whitelist ON ho to teeno naam whitelist karo.
- Server **26.2 / 26.3** jaisa naya ho (library se naya) to server par **ViaVersion + ViaBackwards** dono plugin lagao.
- Aternos bots ko pasand nahi karta, isliye 100% guarantee koi bot nahi de sakta. Ye bot jitna ho sake kick se bachta hai.

## Logs

| Log line | Matlab |
|---|---|
| `version refused with version X - next try uses Y` | X chala nahi, Y try ho raha hai (automatic) |
| `(server told us this version)` | Server ne khud sahi version bata diya |
| `kicked for being AFK - the bot moves more` | AFK kick mila, ab zyada movement |
| `quiet time is longer now` | Server ko movement packet pasand nahi aaya, join ke baad wait badh gaya |
| `server is not answering ... press START` | Aternos server band hai, panel se start karo |
