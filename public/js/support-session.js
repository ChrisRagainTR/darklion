/* Tab-local support access: the administrator's stored login is never replaced. */
(() => {
  "use strict";
  const key = "dl_support_session";
  let session;
  try {
    session = JSON.parse(sessionStorage.getItem(key) || "null");
  } catch (_) {
    sessionStorage.removeItem(key);
  }
  const originalFetch = window.fetch.bind(window);
  const isAdmin =
    location.pathname === "/admin" || location.pathname.startsWith("/admin/");
  window.DLAuth = {
    token: () =>
      !isAdmin && session ? session.token : localStorage.getItem("dl_token"),
    support: !isAdmin && session,
  };
  if (isAdmin || !session) return;
  let ending = false;
  async function exit() {
    if (ending) return;
    ending = true;
    try {
      // The support token ends its own session; 401 means it already ended.
      const res = await originalFetch("/api/support-session", {
        method: "DELETE",
        headers: { Authorization: "Bearer " + session.token },
      });
      if (!res.ok && res.status !== 401)
        throw Error(
          "Could not end the session. Retry, or use the access log to revoke it.",
        );
      sessionStorage.removeItem(key);
      location.replace("/admin/firms/" + session.firmId);
    } catch (e) {
      ending = false;
      const status = document.getElementById("support-status");
      if (status) status.textContent = e.message;
    }
  }
  window.DLSupportExit = exit;
  window.fetch = async (input, init = {}) => {
    const url = new URL(
      input instanceof Request ? input.url : input,
      location.href,
    );
    if (url.origin !== location.origin) return originalFetch(input, init);
    const headers = new Headers(
      init.headers || (input instanceof Request ? input.headers : undefined),
    );
    headers.set("Authorization", "Bearer " + session.token);
    const res = await originalFetch(input, { ...init, headers });
    if (res.status === 401) {
      document
        .getElementById("support-status")
        ?.replaceChildren(
          document.createTextNode("Session expired or revoked. Exit to admin."),
        );
      // Existing screens clear dl_token on 401. Never clear the real admin login.
      return new Response(
        JSON.stringify({
          error: "Support session expired. Exit to admin.",
          code: "SUPPORT_EXPIRED",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    if (res.status === 403) {
      const status = document.getElementById("support-status");
      if (status)
        status.textContent =
          "Read-only support view · Some actions are unavailable · Exit to admin when finished";
    }
    return res;
  };
  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("support-view");
    const banner = document.createElement("aside");
    banner.id = "support-banner";
    banner.setAttribute("aria-label", "Support viewing session");
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "Viewing " + session.firmName + " as " + session.name;
    const status = document.createElement("div");
    status.id = "support-status";
    function tick() {
      const minutes = Math.max(
        0,
        Math.ceil((new Date(session.expiresAt) - Date.now()) / 60000),
      );
      status.textContent = minutes
        ? "Read-only · " + minutes + " minutes remaining · Access recorded"
        : "Session expired. Exit to admin.";
    }
    tick();
    setInterval(tick, 60000);
    info.append(title, status);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Exit to admin";
    button.addEventListener("click", exit);
    banner.append(info, button);
    document.body.prepend(banner);
    const logout = document.getElementById("header-logout-btn");
    if (logout) {
      logout.textContent = "Exit support view";
      logout.addEventListener(
        "click",
        (e) => {
          e.stopImmediatePropagation();
          e.preventDefault();
          exit();
        },
        true,
      );
    }
    document.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    // Disable visible mutation affordances; the server independently rejects writes.
    const mutation =
      /^(add|new|create|save|delete|remove|send|reply|invite|archive|restore|upload|connect|disconnect|sync|refresh data|generate|approve|reject|mark|edit|assign|move|cancel|revoke|enable|disable|deliver|forward|share|bulk|complete)\b/i;
    const disable = () =>
      document
        .querySelectorAll("button, input[type=submit], a.btn, [role=button]")
        .forEach((el) => {
          if (
            el.closest("#support-banner") ||
            !mutation.test(
              (
                el.textContent ||
                el.value ||
                el.getAttribute("aria-label") ||
                ""
              )
                .trim()
                .replace(/^[^a-z]+/i, ""),
            )
          )
            return;
          el.setAttribute("aria-disabled", "true");
          el.title = "Unavailable in read-only support view";
          if ("disabled" in el) el.disabled = true;
        });
    disable();
    new MutationObserver(disable).observe(document.body, {
      childList: true,
      subtree: true,
    });
    document.addEventListener(
      "click",
      (e) => {
        if (e.target.closest("[aria-disabled=true]")) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      },
      true,
    );
    // Account/security forms are not part of a support session.
    document
      .querySelectorAll(
        'a[href="/account"],a[href="/workspace-setup"],a[href="/settings"],a[href="/team"],a[href="/bulk-send"],a[href="/forecast"],a[href="/tax-season"],a[href="/statements-calendar"]',
      )
      .forEach((el) => {
        el.setAttribute("aria-disabled", "true");
        el.title = "Unavailable in read-only support view";
      });
  });
})();
