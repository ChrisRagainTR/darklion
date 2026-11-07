'use strict';

const path = require('path');
const os = require('os');

// Base directory for DarkLion print agent data
const BASE_DIR = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'DarkLion');
const SPOOL_DIR = path.join(BASE_DIR, 'Spool');
const LOG_DIR = path.join(BASE_DIR, 'Logs');

// Named pipe name — per-user so each RDS session gets its own
const username = (process.env.USERNAME || process.env.USER || 'default').replace(/[^a-z0-9_-]/gi, '_');
const PIPE_NAME = `\\\\.\\pipe\\darklion-print-${username}`;

// DarkLion API base URL
const API_BASE = process.env.DARKLION_API_BASE || 'https://darklion.ai';

module.exports = {
  BASE_DIR,
  SPOOL_DIR,
  LOG_DIR,
  PIPE_NAME,
  API_BASE,
  username,
};
