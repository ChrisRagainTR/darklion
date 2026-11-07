'use strict';

/**
 * Installs the DarkLion Print Service as a Windows service.
 * Run as Administrator: node service-install.js
 */

const path = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name: 'DarkLion Print Service',
  description: 'Watches for print jobs and routes them to DarkLion document management.',
  script: path.join(__dirname, 'index.js'),
  nodeOptions: [],
  env: [
    {
      name: 'NODE_ENV',
      value: 'production',
    },
  ],
  // Run as LocalSystem (SYSTEM) — has access to the spool directory
  // and can read the active-sessions.json file written by Electron apps
});

svc.on('install', () => {
  console.log('Service installed. Starting...');
  svc.start();
});

svc.on('start', () => {
  console.log('DarkLion Print Service started.');
});

svc.on('error', (err) => {
  console.error('Service error:', err);
});

svc.install();
