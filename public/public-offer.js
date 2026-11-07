"use strict";
window.offer = (() => {
  const portal = new URLSearchParams(location.search).get("mode") === "client";
  // Client mode signs in with the portal session cookie (js/portal-session.js); a Bearer
  // header is sent only when this page load was handed a token. Staff pages keep dl_token.
  const session = portal ? window.PortalSession : null;
  const key = "dl_token";
  const token = portal ? (session ? session.bearer() : null) : localStorage.getItem(key);
  function message(text, error = false) {
    const node = document.getElementById("status");
    node.textContent = text;
    node.classList.toggle("error", error);
    node.hidden = !text;
  }
  async function api(path, body, method) {
    const response = await fetch(path, {
      method: method || (body ? "POST" : "GET"),
      headers: {
        ...(portal
          ? (session ? session.headers() : {})
          : token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && (token || portal)) {
        signOut();
        throw Error("Please sign in again.");
      }
      if (data.code === "MFA_SETUP_REQUIRED")
        location.href = "/account?required=1";
      throw Error(
        data.error || "Could not complete this request. Please try again.",
      );
    }
    return data;
  }
  function action(id, fn) {
    document.getElementById(id).addEventListener("click", async (event) => {
      event.preventDefault();
      const button = event.currentTarget;
      button.disabled = true;
      message("");
      try {
        await fn();
      } catch (e) {
        message(e.message, true);
      } finally {
        button.disabled = false;
      }
    });
  }
  async function signOut() {
    if (portal) {
      // Ends the session on the server and clears the session cookie.
      if (session) await session.logout();
      location.href = "/portal-login";
      return;
    }
    fetch("/api/account-security/sessions/current/revoke", { method: "POST", keepalive: true, headers: { Authorization: "Bearer " + localStorage.getItem(key) } }).catch(() => {});
    localStorage.removeItem(key);
    location.href = "/login";
  }
  return { api, action, message, portal, token, signOut };
})();
