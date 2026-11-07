'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_STATE = {
  width: 1280,
  height: 860,
};

function getStateFile(app) {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return { ...DEFAULT_STATE };

  const state = {
    width: Math.max(960, Math.floor(bounds.width || DEFAULT_STATE.width)),
    height: Math.max(640, Math.floor(bounds.height || DEFAULT_STATE.height)),
  };

  if (isFiniteNumber(bounds.x)) state.x = Math.floor(bounds.x);
  if (isFiniteNumber(bounds.y)) state.y = Math.floor(bounds.y);

  return state;
}

function loadWindowState(app) {
  try {
    const raw = fs.readFileSync(getStateFile(app), 'utf8');
    return sanitizeBounds(JSON.parse(raw));
  } catch (_) {
    return { ...DEFAULT_STATE };
  }
}

function saveWindowState(app, window) {
  if (!window || window.isDestroyed()) return;

  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  const state = sanitizeBounds(bounds);
  state.isMaximized = window.isMaximized();

  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(getStateFile(app), JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[window-state] Failed to save:', err.message);
  }
}

module.exports = {
  loadWindowState,
  saveWindowState,
};
