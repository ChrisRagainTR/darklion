'use strict';

/**
 * DarkLion Print Agent - Electron Main Process
 *
 * Simplified architecture: Electron handles everything.
 * - Tray icon (invisible on startup)
 * - Chokidar watches the spool folder directly (no separate Windows service)
 * - When a new PDF lands, opens the routing window
 * - JWT auth via Windows Credential Manager (keytar)
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { storeToken, getToken, clearToken, isTokenExpired } = require('./auth');
const { startPrintServer, stopPrintServer } = require('./print-server');

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_DIR = path.join(
  process.env.PROGRAMDATA || 'C:\\ProgramData',
  'DarkLion'
);

// ── State ────────────────────────────────────────────────────────────────────
let tray = null;
let loginWindow = null;
let batchWindow = null; // single routing window for all batched jobs
let pendingJobs = []; // jobs queued while login window is open

// Job batching — collect jobs arriving within BATCH_WINDOW_MS into one window
const BATCH_WINDOW_MS = 3000;
let batchQueue = [];    // { filePath, jobTitle }
let batchTimer = null;

// ── Single instance lock (must be before whenReady per Electron docs) ─────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ── App ready ────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  // Ensure base dir exists
  if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  }

  setupTray();
  startPrintServer(handleNewPrintJob);
  await checkAuth();
});

// Second instance launched — just focus existing
app.on('second-instance', () => {
  if (loginWindow && !loginWindow.isDestroyed()) loginWindow.focus();
});

// CRITICAL: Don't quit when all windows are closed — stay in tray
app.on('window-all-closed', (e) => {
  // Prevent default quit behavior — we live in the tray
});

app.on('before-quit', () => {
  stopPrintServer();
});

// ── Tray ─────────────────────────────────────────────────────────────────────
function setupTray() {
  try {
    // Load bundled icon.ico — works reliably on Windows for tray icons
    const iconPath = path.join(__dirname, 'icon.ico');
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon);
    tray.setToolTip('DarkLion Print Agent — Running');
    const menu = Menu.buildFromTemplate([
      { label: 'DarkLion Print Agent', enabled: false },
      { label: 'Status: Running', enabled: false },
      { type: 'separator' },
      { label: 'Sign Out', click: async () => { await clearToken(); showLoginWindow(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
    console.log('[main] Tray created successfully');
  } catch (err) {
    console.error('[tray] Failed to create tray:', err.message);
    // Don't quit — keep app alive even without tray
  }
}


// ── Handle new print job — with batching ─────────────────────────────────────
async function handleNewPrintJob(filePath, jobTitle) {
  const token = await getToken();
  if (!token || isTokenExpired(token)) {
    pendingJobs.push({ filePath, jobTitle });
    showLoginWindow();
    return;
  }

  // Add to batch queue
  batchQueue.push({ filePath, jobTitle });

  // Reset/start batch timer — wait for more jobs to arrive
  if (batchTimer) clearTimeout(batchTimer);
  batchTimer = setTimeout(() => {
    const jobs = [...batchQueue];
    batchQueue = [];
    batchTimer = null;
    showBatchWindow(jobs);
  }, BATCH_WINDOW_MS);
}

// ── Auth ──────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const token = await getToken();
  if (!token || isTokenExpired(token)) {
    showLoginWindow();
  }
}

// ── Login window ──────────────────────────────────────────────────────────────
function showLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 400,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'DarkLion — Sign In',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  loginWindow.setMenu(null);
  loginWindow.loadFile(path.join(__dirname, 'login.html'));
  loginWindow.on('closed', () => { loginWindow = null; });
}

// ── Batch routing window — one window for all jobs ───────────────────────────
function showBatchWindow(jobs) {
  if (!jobs.length) return;

  // If window already open, add jobs to it
  if (batchWindow && !batchWindow.isDestroyed()) {
    batchWindow.webContents.send('add-jobs', jobs);
    batchWindow.focus();
    return;
  }

  // Height scales with job count, min 500, max 700
  const height = Math.min(700, Math.max(500, 300 + jobs.length * 80));

  batchWindow = new BrowserWindow({
    width: 480,
    height,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: 'Route to DarkLion',
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  batchWindow.setMenu(null);
  batchWindow.loadFile(path.join(__dirname, 'index.html'));

  batchWindow.webContents.on('did-finish-load', () => {
    batchWindow.webContents.send('job-ready', { jobs });
  });

  batchWindow.on('closed', () => {
    // Clean up any remaining spool files
    for (const job of jobs) {
      try { if (fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath); } catch (_) {}
    }
    batchWindow = null;
  });
}

function cleanJobName(raw) {
  if (!raw) return 'Document';
  return raw.replace(/^\d{8}_\d{6}_/, '') || 'Document';
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('search', async (event, query) => {
  const token = await getToken();
  if (!token || isTokenExpired(token)) {
    showLoginWindow();
    throw new Error('Session expired — please sign in again');
  }
  return require('./api').search(query, token);
});

ipcMain.handle('upload', async (event, params) => {
  const token = await getToken();
  if (!token || isTokenExpired(token)) {
    showLoginWindow();
    throw new Error('Session expired — please sign in again');
  }
  return require('./api').uploadDocument({ ...params, token });
});

ipcMain.on('upload-complete', (event, { filePath }) => {
  // Delete the spool file after successful upload
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) {}
  // Don't close window — user may have more jobs in the batch to upload
});

ipcMain.on('all-done', (event) => {
  // User clicked done after uploading all jobs — close the window
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.destroy();
  batchWindow = null;
});

ipcMain.on('cancel', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.destroy();
  batchWindow = null;
});

ipcMain.handle('login', async (event, { email, password }) => {
  const result = await require('./api').login(email, password);
  await storeToken(result.token);
  return result;
});

ipcMain.on('login-success', async () => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.destroy();
    loginWindow = null;
  }
  const jobs = [...pendingJobs];
  pendingJobs = [];
  if (jobs.length) showBatchWindow(jobs);
});

ipcMain.on('logout', async () => {
  await clearToken();
  showLoginWindow();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
