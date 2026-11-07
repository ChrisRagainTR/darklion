'use strict';

const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..', '..');

test.describe('Bulk send schema contract', () => {
  test('defines every table used by the bulk-send route', () => {
    const db = fs.readFileSync(path.join(root, 'server', 'db.js'), 'utf8');
    const route = fs.readFileSync(path.join(root, 'server', 'routes', 'bulk-send.js'), 'utf8');

    expect(route).toContain('INSERT INTO bulk_sends');
    expect(route).toContain('INSERT INTO bulk_send_recipients');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS bulk_sends');
    expect(db).toContain('CREATE TABLE IF NOT EXISTS bulk_send_recipients');
  });

  test('keeps bulk-send history scoped and indexed by firm', () => {
    const db = fs.readFileSync(path.join(root, 'server', 'db.js'), 'utf8');

    expect(db).toContain('firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE');
    expect(db).toContain('ON bulk_sends(firm_id, sent_at DESC)');
  });
});
