const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // bytes (256-bit)
const IV_LENGTH = 12;  // bytes (96-bit recommended for GCM)
const TAG_LENGTH = 16; // bytes

let _key = null;
let _keyChecked = false;
let _warnedOnce = false;

function getKey() {
  if (_keyChecked) return _key;
  _keyChecked = true;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    _key = null;
    return null;
  }

  // Must be 64 hex chars = 32 bytes
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    console.warn('[encryption] ENCRYPTION_KEY is set but invalid (must be 64 hex chars / 32 bytes). Encryption disabled.');
    _key = null;
    return null;
  }

  _key = Buffer.from(raw, 'hex');
  return _key;
}

function warnOnce() {
  if (!_warnedOnce) {
    _warnedOnce = true;
    console.warn('[encryption] ENCRYPTION_KEY not set — sensitive fields will be stored unencrypted. Set ENCRYPTION_KEY in production.');
  }
}

/**
 * Returns true if ENCRYPTION_KEY is set and valid.
 */
function encryptionAvailable() {
  return getKey() !== null;
}

/**
 * Encrypt plaintext string.
 * Returns "iv:authTag:ciphertext" (all hex), or null if text is null/undefined.
 * If ENCRYPTION_KEY is missing, warns once and returns value unmodified.
 */
function encrypt(text) {
  if (text === null || text === undefined) return null;

  const key = getKey();
  if (!key) {
    warnOnce();
    return text;
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a stored "iv:authTag:ciphertext" string.
 * Returns plaintext string, or null if stored is null/undefined.
 * If ENCRYPTION_KEY is missing, warns once and returns value unmodified.
 */
function decrypt(stored) {
  if (stored === null || stored === undefined) return null;

  const key = getKey();
  if (!key) {
    warnOnce();
    return stored;
  }

  try {
    const parts = stored.split(':');
    if (parts.length !== 3) {
      // Not in expected format — may be unencrypted legacy value
      return stored;
    }

    const [ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const ciphertext = Buffer.from(ciphertextHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    console.error('[encryption] decrypt failed:', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt, encryptionAvailable };
