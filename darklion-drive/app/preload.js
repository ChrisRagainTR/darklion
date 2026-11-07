'use strict';

/**
 * preload.js — contextBridge for renderer ↔ main IPC.
 * Exposes a safe API surface to the login window renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('darkLion', {
  /**
   * Attempt login with email/password.
   * Returns { success: true } or { success: false, error: 'message' }
   */
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),

  /**
   * Get version info.
   */
  getVersion: () => ipcRenderer.invoke('get-version'),
});
