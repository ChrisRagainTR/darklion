// Client portal web session (S3c).
// The portal signs in with an HttpOnly cookie that page scripts can't read; same-origin
// requests carry it automatically. This file moves any token the page is handed into that
// cookie and keeps it out of browser storage:
//   - a session saved in localStorage before the cookie existed (migration, no sign-out),
//   - an advisor preview link (?preview_token=),
//   - a token placed by an older iPhone app build before it opens a portal page.
// A handed token is also used as a Bearer header for the rest of this page load only, so the
// page works the same even if the browser drops the cookie. It is never written to storage.
(function () {
  'use strict';
  var LEGACY_KEY = 'portalToken';
  var BOUNCE_KEY = 'portalAuthBounce';
  var JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  function readLegacy() { try { return localStorage.getItem(LEGACY_KEY); } catch (e) { return null; } }
  function dropLegacy() { try { localStorage.removeItem(LEGACY_KEY); } catch (e) {} }

  var previewToken = null;
  try {
    var params = new URLSearchParams(window.location.search);
    previewToken = params.get('preview_token');
    if (previewToken !== null) {
      // Keep the token out of the address bar, history and bookmarks.
      params.delete('preview_token');
      var query = params.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
    }
  } catch (e) {}
  if (previewToken && !JWT.test(previewToken)) previewToken = null;

  var legacy = readLegacy();
  if (legacy !== null && !JWT.test(legacy)) { dropLegacy(); legacy = null; }
  // A preview replaces any saved client session in this browser, as it always has.
  if (previewToken && legacy) { dropLegacy(); legacy = null; }

  var bearer = previewToken || legacy || null;

  var ready = Promise.resolve('cookie');
  if (bearer) {
    ready = window.fetch('/portal-auth/session/adopt', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: 'Bearer ' + bearer },
    }).then(function (res) {
      // Stored copy goes once the server has answered: moved into the cookie, or no longer valid.
      // Any other failure keeps it so the next page load can try again.
      if (legacy && (res.ok || res.status === 401)) dropLegacy();
      return res.ok ? 'adopted' : res.status === 401 ? 'invalid' : 'failed';
    }, function () { return 'failed'; });
  }

  function headers(extra) {
    var out = {};
    if (bearer) out.Authorization = 'Bearer ' + bearer;
    if (extra) for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key];
    return out;
  }

  // Ends the session on the server and clears the cookie. Resolves within a few seconds even offline.
  function logout() {
    dropLegacy();
    var request = window.fetch('/portal-auth/session/logout', { method: 'POST', credentials: 'same-origin', headers: headers() })
      .catch(function () {});
    bearer = null;
    return Promise.race([request, new Promise(function (resolve) { setTimeout(resolve, 4000); })]);
  }

  // Sends the visitor to sign in. The flag stops the sign-in page from bouncing straight back.
  function toLogin(path) {
    dropLegacy();
    try { sessionStorage.setItem(BOUNCE_KEY, String(Date.now())); } catch (e) {}
    window.location.replace(path || '/portal-login');
  }

  window.PortalSession = {
    headers: headers,
    bearer: function () { return bearer; },
    ready: ready,
    logout: logout,
    toLogin: toLogin,
    previewLink: !!previewToken,
  };
})();
