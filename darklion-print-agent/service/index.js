'use strict';

/**
 * DarkLion Print Agent - Windows Service
 *
 * Runs as a Windows service under the SYSTEM account.
 * Watches the spool folder for new PDFs and notifies connected
 * Electron app instances via named pipe.
 *
 * When running as a service, stdout/stderr go to the node-windows log.
 * When running interactively (dev/test), they go to the console.
 */

const path = require('path');
const fs = require('fs');
const { BASE_DIR, SPOOL_DIR, LOG_DIR } = require('../shared/config');
const { startWatcher } = require('./watcher');

// Ensure directories exist
[BASE_DIR, SPOOL_DIR, LOG_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

console.log('[service] DarkLion Print Service starting...');
console.log(`[service] Spool directory: ${SPOOL_DIR}`);

// Start watching
startWatcher();

console.log('[service] Watching for print jobs. Service is running.');

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[service] SIGTERM received — shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[service] SIGINT received — shutting down.');
  process.exit(0);
});

// Keep the process alive
setInterval(() => {
  // Heartbeat — also a good place to do cleanup of old spool files
  cleanupOldFiles();
}, 5 * 60 * 1000); // every 5 minutes

/**
 * Remove PDF files from spool that are older than 24 hours.
 * These are files where the user cancelled or the Electron app didn't run.
 */
function cleanupOldFiles() {
  try {
    const cutoff = Date.now() - (24 * 60 * 60 * 1000);
    const files = fs.readdirSync(SPOOL_DIR);
    for (const f of files) {
      if (!f.endsWith('.pdf')) continue;
      const fp = path.join(SPOOL_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          console.log(`[service] Cleaned up old spool file: ${f}`);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error('[service] Cleanup error:', err.message);
  }
}
