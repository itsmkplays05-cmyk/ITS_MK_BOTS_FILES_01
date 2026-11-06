"use strict";

const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { addLog, getLogs } = require("./logger");
const config = require("./settings.json");

const { GoalBlock, GoalXZ } = goals;
const move = config.movement || {};
const num = (v) => typeof v === "number" && Number.isFinite(v);

// ============================================================
// STATE
// ============================================================
const state = {
  running: true,
  connected: false,
  safeMode: !!move["safe-mode"],
  startTime: Date.now(),
  connectedAt: null,
  reconnectAttempts: 0,
  kicks: 0,
  lastKick: null,
  wasThrottled: false,
};

let bot = null;
let intervals = [];
let reconnectTimer = null;
let connectTimer = null;
let isReconnecting = false;
let lastDiscordSend = 0;

// ============================================================
// WEB SERVER (dashboard + API)
// ============================================================
const app = express();
app.use(express.json());
