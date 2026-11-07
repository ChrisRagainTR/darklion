'use strict';

/**
 * Chokidar file watcher for the DarkLion spool directory.
 * Watches for new .pdf files and notifies connected Electron apps via IPC.
 */

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const { SPOOL_DIR } = require('../shared/config');
const { broadcast } = require('./ipc');

let watcher = null;

function startWatcher() {
  console.log(`[watcher] Watching spool dir: ${SPOOL_DIR}`);

  // Ensure spool dir exists
  if (!fs.existsSync(SPOOL_DIR)) {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
  }

  watcher = chokidar.watch(SPOOL_DIR, {
    // Wait until file is fully written before triggering
    awaitWriteFinish: {
      stabilityThreshold: 1500, // file must be stable for 1.5s
      pollInterval: 200,
    },
    ignoreInitial: true,       // don't fire for files already there on startup
    persistent: true,
    depth: 0,                  // only watch top-level files, not subdirs
  });

  watcher.on('add', (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext !== '.pdf') return;

    const jobName = path.basename(filePath, '.pdf');
    console.log(`[watcher] New PDF: ${filePath}`);

    // Small extra delay to let Ghostscript fully flush and close the file
    setTimeout(() => {
      try {
        // Verify file is readable and non-empty
        const stat = fs.statSync(filePath);
        if (stat.size < 100) {
          console.warn(`[watcher] File too small (${stat.size} bytes), skipping: ${filePath}`);
          return;
        }
        broadcast(filePath, jobName);
      } catch (err) {
        console.error(`[watcher] Error checking file: ${err.message}`);
      }
    }, 500);
  });

  watcher.on('error', (err) => {
    console.error(`[watcher] Error: ${err.message}`);
  });

  return watcher;
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

module.exports = { startWatcher, stopWatcher };
