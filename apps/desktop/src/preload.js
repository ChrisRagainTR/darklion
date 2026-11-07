'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('darklionDesktop', {
  isDesktop: true,
  platform: process.platform,
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  setBadgeCount: (count) => ipcRenderer.invoke('desktop:set-badge-count', count),
  notify: (payload) => ipcRenderer.invoke('desktop:notify', payload),
  navigate: (routePath) => ipcRenderer.invoke('desktop:navigate', routePath),
});
