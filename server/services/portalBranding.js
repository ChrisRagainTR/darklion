'use strict';

function portalBranding(firm, settings = {}) {
  const iconUrl = firm.portal_icon_url ? `/portal-auth/firm-icon/${firm.id}` : '';
  const logoUrl = firm.logo_url ? `/portal-auth/firm-logo/${firm.id}` : '';
  const style = firm.portal_logo_style || (iconUrl ? 'icon' : 'logo');
  return {
    portalLogoStyle: style,
    portalIconUrl: iconUrl,
    portalLogoUrl: style === 'icon' ? (iconUrl || logoUrl) : (logoUrl || iconUrl),
  };
}

module.exports = { portalBranding };
