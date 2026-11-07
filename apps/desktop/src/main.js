'use strict';

const { app, BrowserWindow, Menu, nativeImage, Notification, Tray, ipcMain, shell } = require('electron');
const path = require('path');

const { DARKLION_URL, DARKLION_ORIGIN } = require('./config');
const { loadWindowState, saveWindowState } = require('./window-state');

let mainWindow = null;
let tray = null;
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
const TASKBAR_BADGES_DIR = path.join(__dirname, '..', 'assets', 'taskbar-badges');
const taskbarBadgeIcons = new Map();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

function isAllowedDarkLionUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return parsed.origin === DARKLION_ORIGIN;
  } catch (_) {
    return false;
  }
}

function isSafeExternalUrl(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    return ['https:', 'http:', 'mailto:', 'tel:'].includes(parsed.protocol);
  } catch (_) {
    return false;
  }
}

function openExternalUrl(targetUrl) {
  if (!isSafeExternalUrl(targetUrl)) return;
  shell.openExternal(targetUrl).catch((err) => {
    console.warn('[navigation] Failed to open external URL:', err.message);
  });
}

function loadDarkLionPath(routePath) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const nextUrl = new URL(DARKLION_URL);
  if (typeof routePath === 'string' && routePath.startsWith('/')) {
    nextUrl.pathname = routePath;
    nextUrl.search = '';
    nextUrl.hash = '';
  }
  mainWindow.loadURL(nextUrl.toString());
}

function routeFromDeepLink(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'darklion:') return null;
    const parts = [parsed.hostname].concat(parsed.pathname.split('/').filter(Boolean));
    if (!parts.length) return '/dashboard';

    if (parts[0] === 'team-chat') return '/team-chat';
    if (parts[0] === 'messages') return '/messages';
    if (parts[0] === 'crm' && parts[1] === 'person' && parts[2]) return `/crm/person/${encodeURIComponent(parts[2])}`;
    if (parts[0] === 'crm' && parts[1] === 'company' && parts[2]) return `/crm/company/${encodeURIComponent(parts[2])}`;
    if (parts[0] === 'crm' && parts[1] === 'relationship' && parts[2]) return `/crm/relationship/${encodeURIComponent(parts[2])}`;
    return '/dashboard';
  } catch (_) {
    return null;
  }
}

function handleDeepLink(rawUrl) {
  const routePath = routeFromDeepLink(rawUrl);
  if (!routePath) return false;
  focusMainWindow();
  loadDarkLionPath(routePath);
  return true;
}

function focusMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function handleNavigation(event, targetUrl) {
  if (isAllowedDarkLionUrl(targetUrl)) return;

  event.preventDefault();
  openExternalUrl(targetUrl);
}

function createMainWindow() {
  const savedState = loadWindowState(app);

  mainWindow = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 960,
    minHeight: 640,
    title: 'DarkLion',
    icon: ICON_PATH,
    backgroundColor: '#0f1724',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (savedState.isMaximized) mainWindow.maximize();
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedDarkLionUrl(url)) {
      mainWindow.loadURL(url);
    } else {
      openExternalUrl(url);
    }

    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', handleNavigation);
  mainWindow.webContents.on('will-redirect', handleNavigation);

  mainWindow.on('close', () => saveWindowState(app, mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(DARKLION_URL);
}

function createTray() {
  if (tray) return tray;

  tray = new Tray(ICON_PATH);
  tray.setToolTip('DarkLion Desktop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open DarkLion', click: () => focusMainWindow() },
    { label: 'Open Team Chat', click: () => { focusMainWindow(); loadDarkLionPath('/team-chat'); } },
    { label: 'Open Messages', click: () => { focusMainWindow(); loadDarkLionPath('/messages'); } },
    { type: 'separator' },
    { label: 'Reload', click: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload(); } },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', () => focusMainWindow());
  return tray;
}

ipcMain.handle('app-info', () => ({
  name: app.getName(),
  version: app.getVersion(),
  darklionUrl: DARKLION_URL,
}));

function getTaskbarBadgeIcon(count) {
  const capped = Math.max(1, Math.min(99, Number.parseInt(count || 0, 10) || 1));
  const key = count > 99 ? '99-plus' : String(capped);
  if (taskbarBadgeIcons.has(key)) return taskbarBadgeIcons.get(key);
  const icon = nativeImage.createFromPath(path.join(TASKBAR_BADGES_DIR, `${key}.png`));
  taskbarBadgeIcons.set(key, icon);
  return icon;
}

function updateTaskbarUnreadIndicator(count) {
  app.setBadgeCount(count);
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (count > 0) {
    mainWindow.setOverlayIcon(getTaskbarBadgeIcon(count), `${count} unread`);
    if (!mainWindow.isFocused()) mainWindow.flashFrame(true);
  } else {
    mainWindow.setOverlayIcon(null, '');
    mainWindow.flashFrame(false);
  }
}

ipcMain.handle('desktop:set-badge-count', (_event, rawCount) => {
  const count = Math.max(0, Math.min(9999, Number.parseInt(rawCount || 0, 10) || 0));
  updateTaskbarUnreadIndicator(count);
  return { ok: true, count };
});

ipcMain.handle('desktop:notify', (_event, payload = {}) => {
  if (!Notification.isSupported()) return { ok: false, reason: 'unsupported' };

  const title = String(payload.title || 'DarkLion').slice(0, 120);
  const body = String(payload.body || '').slice(0, 260);
  const route = typeof payload.route === 'string' && payload.route.startsWith('/') ? payload.route : null;
  const notification = new Notification({
    title,
    body,
    silent: payload.silent === true,
  });

  notification.on('click', () => {
    focusMainWindow();
    if (route) loadDarkLionPath(route);
  });
  notification.show();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(true);
    const existingBadge = app.getBadgeCount ? app.getBadgeCount() : 0;
    if (existingBadge > 0) updateTaskbarUnreadIndicator(existingBadge);
  }
  return { ok: true };
});

ipcMain.handle('desktop:navigate', (_event, routePath) => {
  if (typeof routePath !== 'string' || !routePath.startsWith('/')) return { ok: false, reason: 'invalid-route' };
  focusMainWindow();
  loadDarkLionPath(routePath);
  return { ok: true };
});

app.whenReady().then(() => {
  app.setAsDefaultProtocolClient('darklion');
  Menu.setApplicationMenu(null);
  createMainWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('second-instance', (_event, argv) => {
  const deepLink = argv.find((arg) => typeof arg === 'string' && arg.startsWith('darklion://'));
  if (deepLink && handleDeepLink(deepLink)) return;

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
