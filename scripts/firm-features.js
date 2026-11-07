'use strict';

// No credentials in arguments; DATABASE_URL comes from the operator environment.
// No initDB, workers, migrations, or public write endpoint are started here.
const { parseArgs } = require('node:util');

async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    'firm-id': { type: 'string' }, feature: { type: 'string' },
    enabled: { type: 'string' }, expected: { type: 'string' }, reason: { type: 'string' },
    environment: { type: 'string' },
  } });
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be supplied through the environment');
  if (!values.environment || values.environment !== process.env.RAILWAY_ENVIRONMENT_NAME) {
    throw new Error('--environment must match RAILWAY_ENVIRONMENT_NAME');
  }
  const { pool } = require('../server/db');
  const { getFirmFeatures, setFirmFeature } = require('../server/services/firmFeatures');
  try {
    if (values.feature === undefined) {
      if (values.enabled !== undefined || values.expected !== undefined || values.reason !== undefined) throw new Error('--feature is required for a change');
      return { firmId: Number(values['firm-id']), features: await getFirmFeatures(values['firm-id']) };
    }
    if (![values.enabled, values.expected].every(v => ['true', 'false'].includes(v))) {
      throw new Error('--enabled and --expected must each be true or false');
    }
    return await setFirmFeature({ firmId: values['firm-id'], feature: values.feature,
      enabled: values.enabled === 'true', expected: values.expected === 'true', reason: values.reason });
  } finally { await pool.end(); }
}

if (require.main === module) main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  // Database errors may contain connection/record details. Print only our input
  // errors; operational failures need the private server logs for diagnosis.
  const safe = /^(DATABASE_URL|--|A valid firm|Unknown feature|Enabled and|A reason|Firm not found|Feature changed)/;
  console.error(safe.test(error.message) ? error.message : 'Feature command failed');
  process.exitCode = 1;
});

module.exports = { main };
