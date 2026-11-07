'use strict';

const path = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name: 'DarkLion Print Service',
  script: path.join(__dirname, 'index.js'),
});

svc.on('uninstall', () => {
  console.log('DarkLion Print Service uninstalled.');
});

svc.uninstall();
