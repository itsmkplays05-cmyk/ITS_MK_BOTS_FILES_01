"use strict";

const MAX_LOGS = 300;
const logs = [];

function addLog(...args) {
  const time = new Date().toLocaleTimeString("en-GB");
  const text = args
    .map((a) => (typeof a === "string" ? a : a && a.message ? a.message : JSON.stringify(a)))
    .join(" ");
  const line = `[${time}] ${text}`;
  console.log(line);
  logs.push(line);
  if (logs.length > MAX_LOGS) logs.shift();
}

function getLogs() {
  return logs;
}

module.exports = { addLog, getLogs };
