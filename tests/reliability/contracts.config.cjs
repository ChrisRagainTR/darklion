'use strict';
const path = require('node:path');
module.exports = {
  testDir: path.resolve(__dirname, '../e2e'),
  testMatch: ['communication-archive-contract.spec.js', 'document-folders-contract.spec.js',
    'agent-communications-contract.spec.js', 'agent-work-mcp-auth.spec.js',
    'marketing-registration-static.spec.js'],
  workers: 1,
  reporter: 'list',
  outputDir: path.resolve(__dirname, '../results/contracts'),
};
