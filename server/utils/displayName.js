'use strict';

/**
 * Format a person's display name, showing the spouse as a couple when spouse_name is set.
 *
 * Rules:
 *  - No spouse_name                              → "Carl Bierbaum"
 *  - Spouse shares last name (or single word)    → "Carl and Renee Bierbaum"
 *  - Spouse has a different last name            → "Carl Bierbaum and Kaitlyn Curnow"
 *
 * @param {{first_name?: string, last_name?: string, spouse_name?: string}} person
 * @returns {string}
 */
function formatPersonDisplayName(person) {
  if (!person) return '';
  const first = String(person.first_name || '').trim();
  const last = String(person.last_name || '').trim();
  const spouseRaw = String(person.spouse_name || '').trim();

  const personName = [first, last].filter(Boolean).join(' ');

  if (!spouseRaw) return personName || 'Unnamed';
  if (!personName) return spouseRaw;

  const spouseParts = spouseRaw.split(/\s+/).filter(Boolean);

  // Single-word spouse name → treat as first name only, share person's surname
  if (spouseParts.length === 1) {
    if (last) return `${first} and ${spouseRaw} ${last}`.trim();
    return `${first} and ${spouseRaw}`.trim();
  }

  const spouseFirst = spouseParts[0];
  const spouseLast = spouseParts.slice(1).join(' ');

  // Same last name (case-insensitive) → condense
  if (last && spouseLast.toLowerCase() === last.toLowerCase()) {
    return `${first} and ${spouseFirst} ${last}`.trim();
  }

  // Different last names → list both in full
  return `${personName} and ${spouseRaw}`.trim();
}

/**
 * Decorate a person row with a `display_name` field computed from the couple rule.
 * Safe to call even when the row already has a SQL-built display_name — this
 * overrides it with the couple-aware version.
 */
function attachCoupleDisplayName(row) {
  if (!row) return row;
  row.display_name = formatPersonDisplayName(row);
  return row;
}

module.exports = {
  formatPersonDisplayName,
  attachCoupleDisplayName,
};
