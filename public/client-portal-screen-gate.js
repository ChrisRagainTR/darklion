// Phone and tablet browsers use the responsive portal. Native apps remain optional.
(function () {
  'use strict';
  function apply() {
    document.documentElement.classList.remove('client-portal-screen-blocked');
    if (document.body) document.body.classList.remove('client-portal-screen-blocked');
    return false;
  }
  window.DarkLionPortalScreenGate = { shouldBlock: function () { return false; }, apply: apply };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
})();
