'use strict';

/**
 * Named pipe IPC server (runs in the Windows service / SYSTEM context).
 * Each RDS user session has its own Electron app that connects on its own
 * per-user pipe. When a new PDF lands in the spool folder, the service
 * broadcasts to ALL connected Electron clients — the right one will be
 * in the foreground for the user who clicked Print.
 *
 * Protocol: newline-delimited JSON
 *   Service → Electron: { event: "new-print", filePath: "...", jobName: "..." }
 *   Electron → Service: { event: "ack", filePath: "..." }  (optional)
 */

const net = require('net');
const path = require('path');
const fs = require('fs');

// We maintain a list of active per-user pipes so the service can notify any
// logged-in user. Electron connects to its own pipe name on startup.
// Pipe names: \\.\pipe\darklion-print-{USERNAME}
// The service discovers active user sessions and connects to their pipes.

const connectedClients = new Map(); // pipeName → socket

/**
 * Notify a specific user's Electron app about a new print job.
 * @param {string} username
 * @param {string} filePath
 * @param {string} jobName
 */
function notifyUser(username, filePath, jobName) {
  const safeName = (username || 'default').replace(/[^a-z0-9_-]/gi, '_');
  const pipeName = `\\\\.\\pipe\\darklion-print-${safeName}`;
  const msg = JSON.stringify({ event: 'new-print', filePath, jobName }) + '\n';

  // Try to reuse existing socket
  if (connectedClients.has(pipeName)) {
    const sock = connectedClients.get(pipeName);
    if (!sock.destroyed) {
      try { sock.write(msg); return; } catch (_) {}
    }
    connectedClients.delete(pipeName);
  }

  // Open a new connection to the Electron-side pipe server
  const client = net.createConnection(pipeName);
  client.on('connect', () => {
    connectedClients.set(pipeName, client);
    client.write(msg);
  });
  client.on('error', (err) => {
    // Electron not running for this user — silently ignore
    console.log(`[ipc] Could not reach pipe for ${username}: ${err.message}`);
    connectedClients.delete(pipeName);
  });
  client.on('close', () => connectedClients.delete(pipeName));
}

/**
 * Broadcast to all currently-logged-in users (best effort).
 * The service doesn't know which user printed, so it notifies everyone.
 * Electron on the user's session will handle it if the file is new.
 */
function broadcast(filePath, jobName) {
  // Get a list of active user sessions via query user / qwinsta
  // Fall back to just broadcasting to a set of known usernames from the spool filenames
  // or from a sessions file the Electron apps maintain.
  const sessionsFile = path.join(
    process.env.PROGRAMDATA || 'C:\\ProgramData',
    'DarkLion',
    'active-sessions.json'
  );

  let usernames = [];
  try {
    if (fs.existsSync(sessionsFile)) {
      const data = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      usernames = data.usernames || [];
    }
  } catch (_) {}

  if (usernames.length === 0) {
    // Try to derive from environment (useful when running interactively for testing)
    const u = process.env.USERNAME;
    if (u) usernames = [u];
  }

  for (const u of usernames) {
    notifyUser(u, filePath, jobName);
  }
}

module.exports = { broadcast, notifyUser };
