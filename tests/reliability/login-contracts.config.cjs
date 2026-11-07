module.exports = {
  testDir: '../e2e',
  testMatch: ['portal-password-reset-regression.spec.js', 'portal-invite-regression.spec.js', 'portal-username-copy-regression.spec.js'],
  reporter: 'list',
  outputDir: '../results/login-contracts',
  workers: 1,
};
