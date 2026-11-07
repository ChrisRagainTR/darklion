const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: '../e2e', testMatch: ['portal-*-static.spec.js', 'portal-username-copy-regression.spec.js'], workers: 1, reporter: 'list', outputDir: '../results/reliability', use: { headless: true } });
