'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { portalBranding } = require('../../server/services/portalBranding');

test('each firm can use its own icon or wide logo', () => {
  const firm = { id: 72, email: 'owner@example.invalid', logo_url: 'logos/72/logo.png', portal_icon_url: 'logos/72/portal-icon.png' };
  assert.equal(portalBranding(firm).portalLogoUrl, '/portal-auth/firm-icon/72');
  const wide = portalBranding({ ...firm, portal_logo_style: 'logo' });
  assert.equal(wide.portalLogoUrl, '/portal-auth/firm-logo/72');
  assert.equal(wide.portalIconUrl, '/portal-auth/firm-icon/72');
  assert.equal(portalBranding({ ...firm, portal_icon_url: null }).portalIconUrl, '');
  assert.equal(portalBranding({ id: 73, email: 'other@example.invalid' }).portalLogoUrl, '');
  assert.equal(portalBranding({ id: 1, email: 'owner@example.invalid' }).portalLogoUrl, '');
});
