'use strict';

const { generateClosePackage } = require('./reports');
const { generateLedgerHqClosePackage } = require('./ledgerhq');

async function generateClosePackageForProvider(options = {}) {
  const provider = options.provider || 'qbo';
  if (provider === 'ledgerhq') {
    return generateLedgerHqClosePackage(
      options.companyId,
      options.firmId,
      options.period,
      options.startDate,
      options.endDate
    );
  }

  if (provider === 'qbo') {
    return generateClosePackage(
      options.realmId,
      options.period,
      options.startDate,
      options.endDate
    );
  }

  throw new Error(`Unsupported close package provider: ${provider}`);
}

module.exports = {
  generateClosePackageForProvider,
};
