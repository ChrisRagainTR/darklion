'use strict';

const DEFAULT_DARKLION_URL = 'https://darklion.ai';

function normalizeAppUrl(rawUrl) {
  const value = (rawUrl || DEFAULT_DARKLION_URL).trim();

  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new Error(`Invalid DARKLION_DESKTOP_URL: ${value}`);
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('DARKLION_DESKTOP_URL must use http or https');
  }

  parsed.hash = '';
  return parsed.toString();
}

const DARKLION_URL = normalizeAppUrl(process.env.DARKLION_DESKTOP_URL || process.env.DARKLION_URL);
const DARKLION_ORIGIN = new URL(DARKLION_URL).origin;

module.exports = {
  DARKLION_URL,
  DARKLION_ORIGIN,
};
