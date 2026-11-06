const log = require('./logger');
const botm = require('./bot');
const startPanel = require('./panel');

startPanel();
botm.start();

const quit = () => { botm.stop(); setTimeout(() => process.exit(0), 500); };
process.on('SIGTERM', quit); process.on('SIGINT', quit);
process.on('uncaughtException', (e) => log.error('uncaught:', e.message));
process.on('unhandledRejection', (e) => log.error('unhandled:', e && e.message));
