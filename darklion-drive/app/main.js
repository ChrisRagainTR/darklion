'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');

// Log to file so we can diagnose crashes in installed (no-terminal) mode
var logFile = path.join(os.homedir(), 'AppData', 'Roaming', 'DarkLion Drive', 'app.log');
try { require('fs').mkdirSync(path.dirname(logFile), { recursive: true }); } catch(e) {}
var _origLog = console.log.bind(console);
var _origWarn = console.warn.bind(console);
var _origErr = console.error.bind(console);
function writeLog(level, args) {
  try {
    var line = '[' + new Date().toISOString() + '] [' + level + '] ' + args.map(String).join(' ') + '\n';
    fs.appendFileSync(logFile, line);
  } catch(e) {}
}
console.log   = function() { _origLog.apply(console, arguments);  writeLog('INFO',  Array.from(arguments)); };
console.warn  = function() { _origWarn.apply(console, arguments); writeLog('WARN',  Array.from(arguments)); };
console.error = function() { _origErr.apply(console, arguments);  writeLog('ERROR', Array.from(arguments)); };
process.on('uncaughtException', function(e) { writeLog('CRASH', [e.stack || e.message]); });

var electron = require('electron');
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var ipcMain = electron.ipcMain;
var Tray = electron.Tray;
var Menu = electron.Menu;
var nativeImage = electron.nativeImage;
var powerMonitor = electron.powerMonitor;

// Single instance lock - MUST be before app.whenReady()
var gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Lazy-loaded modules
var auth = null;
var apiModule = null;
var webdavServer = null;
var drive = null;

function loadModules() {
  auth = require('./auth');
  apiModule = require('./api');
  webdavServer = require('./webdav-server');
  drive = require('./drive');
}

// App state
var tray = null;
var loginWindow = null;
var isConnected = false;
var currentToken = null;

// Tray icons as base64 PNGs (16x16)
// GOLD = connected state, GREY = disconnected state
var GOLD_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGPgF1f5TwlmGJwGnFzhgxUTZQAuzbgMYSBFMzZDRg2gtgEURyNVEtLgyAukYACSBsiYUYvh7QAAAABJRU5ErkJggg==';
var GREY_ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAANElEQVR4nGPgF1f5TwlmGJwGpKSkYMVEGYBLMy5DGEjRjM2QUQOobQDF0UiVhDQ48gIpGAAJd5bAmYtGRwAAAABJRU5ErkJggg==';

function createTrayIcon(connected) {
  try {
    // Try to load the real lion icon from the app directory
    var iconPath = path.join(__dirname, 'icon.ico');
    if (require('fs').existsSync(iconPath)) {
      var img = nativeImage.createFromPath(iconPath);
      if (!img.isEmpty()) {
        // Resize to appropriate tray size
        return img.resize({ width: 16, height: 16 });
      }
    }
  } catch (e) { /* fall through */ }
  try {
    var b64 = connected ? GOLD_ICON_B64 : GREY_ICON_B64;
    var img2 = nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    if (!img2.isEmpty()) return img2;
  } catch (e) { /* fall through */ }
  return nativeImage.createEmpty();
}

function buildTrayMenu() {
  var statusLabel = isConnected
    ? 'DarkLion Drive  ✓ Connected'
    : 'DarkLion Drive -- Not Connected';

  return Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { type: 'separator' },
    {
      label: 'Open Drive',
      enabled: isConnected,
      click: function() {
        if (drive) drive.openDrive();
      }
    },
    { type: 'separator' },
    {
      label: 'Log Out',
      click: function() {
        disconnectDrive().then(function() {
          if (auth) auth.clearAuth();
          showLoginWindow();
        });
      }
    },
    {
      label: 'Quit',
      click: function() {
        disconnectDrive().then(function() {
          app.quit();
        });
      }
    }
  ]);
}

function updateTray() {
  if (!tray) return;
  tray.setImage(createTrayIcon(isConnected));
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(isConnected ? 'DarkLion Drive -- Connected' : 'DarkLion Drive -- Disconnected');
}

function showLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  var appPath = app.getAppPath();
  // When built with directories.app=app, getAppPath() returns the app/ dir directly.
  // In dev (npm start from root), it returns the project root, so we need app/ subdir.
  // Detect by checking if preload.js exists at appPath directly.
  var preloadBase = require('fs').existsSync(path.join(appPath, 'preload.js')) ? appPath : path.join(appPath, 'app');

  loginWindow = new BrowserWindow({
    width: 420,
    height: 520,
    resizable: false,
    frame: true,
    title: 'DarkLion Drive -- Login',
    backgroundColor: '#0f1724',
    webPreferences: {
      preload: path.join(preloadBase, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  loginWindow.loadFile(path.join(preloadBase, 'renderer', 'login.html'));
  loginWindow.setMenuBarVisibility(false);

  loginWindow.on('closed', function() {
    loginWindow = null;
  });
}

// Called when rclone unexpectedly disconnects (crash, auth error, etc.)
function onDriveDisconnected() {
  console.log('[Main] Drive disconnected unexpectedly');
  isConnected = false;
  currentToken = null;
  updateTray();
  if (auth) auth.clearAuth();
  showLoginWindow();
}

function connectDrive(token) {
  console.log('[Main] Starting WebDAV server on port 7891...');
  return webdavServer.startServer(function() {
    // Called when WebDAV server gets a 401 from the API (token expired)
    console.log('[Main] Token expired, showing login');
    isConnected = false;
    currentToken = null;
    if (drive) drive.unmountDrive();
    if (auth) auth.clearAuth();
    updateTray();
    showLoginWindow();
  }).then(function() {
    console.log('[Main] Mounting drive via rclone...');
    return drive.mountDrive(token, onDriveDisconnected);
  }).then(function() {
    isConnected = true;
    currentToken = token;
    updateTray();
    console.log('[Main] Drive connected successfully on O:');
    return true;
  }).catch(function(err) {
    console.error('[Main] connectDrive failed:', err.message);
    isConnected = false;
    currentToken = null;
    updateTray();
    throw err;
  });
}

function disconnectDrive() {
  var p = Promise.resolve();
  if (drive) {
    p = p.then(function() {
      return drive.unmountDrive();
    }).catch(function(e) {
      console.warn('[Main] Unmount error:', e.message);
    });
  }
  if (webdavServer) {
    p = p.then(function() {
      return webdavServer.stopServer();
    }).catch(function(e) {
      console.warn('[Main] Stop server error:', e.message);
    });
  }
  return p.then(function() {
    isConnected = false;
    currentToken = null;
    updateTray();
  });
}

// IPC: login handler
ipcMain.handle('login', function(event, creds) {
  return apiModule.login(creds.email, creds.password).then(function(result) {
    var token = result.token;
    var firm = result.firm;

    auth.saveAuth(token, creds.email, (firm && firm.name) || '');

    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.close();
    }

    return connectDrive(token).then(function() {
      return { success: true };
    });
  }).catch(function(err) {
    console.error('[IPC] Login error:', err.message);
    return { success: false, error: err.message || 'Login failed' };
  });
});

ipcMain.handle('get-version', function() {
  return app.getVersion();
});

// App ready
app.whenReady().then(function() {
  loadModules();

  // Auto-start on Windows login
  app.setLoginItemSettings({ openAtLogin: true });

  // Create system tray icon (disconnected state initially)
  tray = new Tray(createTrayIcon(false));
  tray.setToolTip('DarkLion Drive');
  tray.setContextMenu(buildTrayMenu());

  tray.on('double-click', function() {
    if (isConnected) {
      drive.openDrive();
    } else {
      showLoginWindow();
    }
  });

  // Try auto-connect if we have a stored token
  var stored = auth.loadAuth();
  if (stored && stored.token) {
    console.log('[Main] Found stored token, attempting auto-connect...');
    connectDrive(stored.token).then(function() {
      console.log('[Main] Auto-connect successful');
    }).catch(function(err) {
      console.warn('[Main] Auto-connect failed, showing login:', err.message);
      auth.clearAuth();
      showLoginWindow();
    });
  } else {
    showLoginWindow();
  }
});

// Reconnect drive after wake from sleep
powerMonitor.on('resume', function() {
  console.log('[Main] System resumed from sleep, checking drive...');
  setTimeout(function() {
    if (isConnected && currentToken) {
      console.log('[Main] Reconnecting drive after wake...');
      drive.unmountDrive().catch(function() {}).then(function() {
        return connectDrive(currentToken);
      }).then(function() {
        console.log('[Main] Drive reconnected after wake');
      }).catch(function(err) {
        console.warn('[Main] Reconnect after wake failed:', err.message);
        isConnected = false;
        currentToken = null;
        updateTray();
        var stored2 = auth.loadAuth();
        if (stored2 && stored2.token) {
          connectDrive(stored2.token).catch(function() {
            auth.clearAuth();
            showLoginWindow();
          });
        } else {
          showLoginWindow();
        }
      });
    } else {
      var stored2 = auth.loadAuth();
      if (stored2 && stored2.token) {
        console.log('[Main] Attempting auto-connect from stored token after wake...');
        connectDrive(stored2.token).catch(function(err) {
          console.warn('[Main] Wake auto-connect failed:', err.message);
          auth.clearAuth();
          showLoginWindow();
        });
      }
    }
  }, 2000); // short delay to let network come back up after wake
});

// Focus existing window if second instance launched
app.on('second-instance', function() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
  }
});

// Keep app alive even with no windows open (lives in tray)
app.on('window-all-closed', function(e) {
  e.preventDefault();
});

// Clean up before quit
app.on('before-quit', function() {
  console.log('[Main] App quitting, cleaning up...');
  disconnectDrive();
});
