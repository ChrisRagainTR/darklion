'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Routing window: initial jobs payload
  onJobReady: (callback) => {
    ipcRenderer.on('job-ready', (event, data) => callback(data));
  },

  // Additional jobs added while window is open
  onAddJobs: (callback) => {
    ipcRenderer.on('add-jobs', (event, jobs) => callback(jobs));
  },

  // Search for clients
  search: (query) => ipcRenderer.invoke('search', query),

  // Upload a document
  upload: (params) => ipcRenderer.invoke('upload', params),

  // Notify main that a single file was uploaded (for cleanup)
  uploadComplete: (filePath) => ipcRenderer.send('upload-complete', { filePath }),

  // All jobs done — close window
  allDone: () => ipcRenderer.send('all-done'),

  // Cancel — close without uploading
  cancel: () => ipcRenderer.send('cancel'),

  // Login
  login: (email, password) => ipcRenderer.invoke('login', { email, password }),

  // Notify main that login succeeded
  loginSuccess: () => ipcRenderer.send('login-success'),

  // Logout
  logout: () => ipcRenderer.send('logout'),
});
