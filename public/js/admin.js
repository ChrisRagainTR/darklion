(() => {
  "use strict";
  // The workspace login only requests an emailed code. The unlocked admin token
  // is tab-scoped, so a copied workspace login alone cannot reach this API.
  const ADMIN_KEY = "dl_admin_token";
  const adminToken = () => sessionStorage.getItem(ADMIN_KEY);
  const main = document.getElementById("main");
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const money = (cents, currency = "usd") =>
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
      cents / 100,
    );
  const timestamp = (value) =>
    value
      ? new Date(value).toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }) + " ET"
      : "Not available";
  const date = (value) =>
    value
      ? new Date(value).toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Not available";
  const labels = {
    active: "Active",
    trialing: "Trial",
    past_due: "Past due",
    unpaid: "Unpaid",
    canceled: "Canceled",
    unsubscribed: "Not subscribed",
    exempt: "Legacy / exempt",
    incomplete: "Incomplete",
    incomplete_expired: "Expired",
    paused: "Paused",
    paid: "Paid",
    open: "Open",
    draft: "Draft",
    void: "Void",
    uncollectible: "Uncollectible",
  };
  const badge = (status) =>
    `<span class="badge ${esc(status)}">${esc(labels[status] || status || "Unknown")}</span>`;
  function toLogin() {
    localStorage.removeItem("dl_token");
    location.replace("/login?returnTo=" + encodeURIComponent(location.pathname));
    throw Object.assign(Error("Sign in to continue"), { code: "SIGNED_OUT" });
  }
  async function api(path, options = {}, { staff = false } = {}) {
    const token = staff ? localStorage.getItem("dl_token") : adminToken();
    if (!token) {
      if (staff) toLogin();
      throw Object.assign(Error("Unlock the admin center"), { code: "ADMIN_LOCKED" });
    }
    const res = await fetch("/api/platform-admin" + path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + token,
      },
    });
    let data;
    try {
      data = await res.json();
    } catch (_) {
      data = { error: res.ok ? "Unexpected response" : `Request failed (${res.status}). Please retry.` };
    }
    if (!res.ok) {
      if (res.status === 401) {
        if (staff) toLogin();
        sessionStorage.removeItem(ADMIN_KEY);
        data.code = "ADMIN_LOCKED";
      }
      const error = Error(data.error || "Request failed");
      error.code = data.code;
      throw error;
    }
    return data;
  }
  function showError(e) {
    if (e.code === "SIGNED_OUT") return;
    if (e.code === "ADMIN_LOCKED") return unlock().catch(showError);
    main.innerHTML = `<h1>Admin center</h1><div class="message error" role="alert">${esc(e.message)}</div><button id="retry">Try again</button>`;
    document.getElementById("retry")?.addEventListener("click", init);
  }
  async function unlock() {
    const status = await api("/status", {}, { staff: true });
    document.getElementById("admin-name").textContent = status.name;
    main.innerHTML = `<form id="unlock" class="panel unlock"><h1>Unlock admin center</h1><p>We'll email a 6-digit code to <strong>${esc(status.email)}</strong>. Admin access lasts up to 8 hours in this tab.</p><div id="unlock-step"><button class="primary" id="send-code" type="submit">Email me a code</button></div><div id="unlock-error" role="alert"></div></form>`;
    const form = document.getElementById("unlock"),
      errorBox = document.getElementById("unlock-error");
    let challengeId = null;
    const showUnlockError = (e) => {
      if (e.code === "SIGNED_OUT") return;
      errorBox.textContent = e.message;
      errorBox.className = "message error";
    };
    async function send() {
      const result = await api("/unlock", { method: "POST" }, { staff: true });
      challengeId = result.challengeId;
      document.getElementById("unlock-step").innerHTML = `<label for="code">Code sent to ${esc(result.sentTo)}</label><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required><button class="primary" type="submit">Unlock</button><p class="footnote">Expires in 10 minutes. <a href="#" id="resend">Send a new code</a></p>`;
      document.getElementById("code").focus();
      document.getElementById("resend").addEventListener("click", (event) => {
        event.preventDefault();
        errorBox.textContent = "";
        errorBox.className = "";
        send().catch(showUnlockError);
      });
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      errorBox.textContent = "";
      errorBox.className = "";
      try {
        if (!challengeId) return await send();
        const result = await api(
          "/unlock/verify",
          { method: "POST", body: JSON.stringify({ challengeId, code: document.getElementById("code").value }) },
          { staff: true },
        );
        sessionStorage.setItem(ADMIN_KEY, result.token);
        await init();
      } catch (e) {
        showUnlockError(e);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  }
  const sessionState = (r) =>
    r.active
      ? "Active"
      : r.ended_at
        ? r.ended_by_name
          ? "Ended by " + r.ended_by_name
          : "Ended"
        : "Expired";
  function logMarkup(rows) {
    return rows.length
      ? rows
          .map(
            (r) =>
              `<div class="activity"><strong>${esc(r.admin_name)}</strong> viewed as ${esc(r.target_name)}<p>${esc(r.firm_name)} · ${esc(timestamp(r.created_at))} · ${esc(sessionState(r))}</p><p>${esc(r.reason)}</p>${r.active ? `<button data-revoke="${esc(r.id)}">End session</button>` : ""}${r.request_count ? `<button data-events="${esc(r.id)}">Show ${r.request_count} requests</button><div class="events" hidden></div>` : ""}</div>`,
          )
          .join("")
      : "<p>No support sessions yet.</p>";
  }
  function bindEvents(container) {
    container.querySelectorAll("[data-events]").forEach((button) =>
      button.addEventListener("click", async () => {
        const box = button.nextElementSibling;
        if (!box.hidden) {
          box.hidden = true;
          return;
        }
        button.disabled = true;
        try {
          const events = await api("/support-sessions/" + button.dataset.events + "/events");
          const time = (v) =>
            new Date(v).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
          box.innerHTML = events
            .map(
              (e) =>
                `<div class="event${e.allowed ? "" : " blocked"}"><span>${esc(time(e.first_at))}</span><code>${esc(e.method)} ${esc(e.path)}</code><span>${e.count > 1 ? "×" + e.count + " " : ""}${e.allowed ? "" : "Blocked"}</span></div>`,
            )
            .join("");
          box.hidden = false;
        } catch (e) {
          box.innerHTML = `<p role="alert" class="error">${esc(e.message)}</p>`;
          box.hidden = false;
        } finally {
          button.disabled = false;
        }
      }),
    );
  }
  function bindRevokes(container, reload) {
    container.querySelectorAll("[data-revoke]").forEach((button) =>
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await api("/support-sessions/" + button.dataset.revoke, {
            method: "DELETE",
          });
          await reload();
        } catch (e) {
          button.disabled = false;
          button.textContent = "Retry ending session";
          container.insertAdjacentHTML(
            "beforeend",
            `<p role="alert" class="error">${esc(e.message)}</p>`,
          );
        }
      }),
    );
  }
  async function directory() {
    const firms = await api("/firms");
    main.innerHTML = `<h1>Firms</h1><p class="subtitle">Manage firm access and DarkLion subscriptions.</p><p>${firms.length} firms · ${firms.filter((f) => f.status === "active").length} active · ${firms.filter((f) => ["past_due", "unpaid"].includes(f.status)).length} need billing attention</p><div class="toolbar"><label for="search" class="sr-only">Search firms or owners</label><input id="search" type="search" placeholder="Search firms or owners…"><label for="status" class="sr-only">Subscription status</label><select id="status"><option value="">All statuses</option>${Object.entries(
      labels,
    )
      .filter(
        ([k]) =>
          !["paid", "open", "draft", "void", "uncollectible"].includes(k),
      )
      .map(([k, v]) => `<option value="${k}">${v}</option>`)
      .join(
        "",
      )}</select></div><div class="table-wrap"><table><thead><tr><th>Firm</th><th>Owner</th><th>Subscription</th><th>Staff seats</th><th>Monthly estimate</th><th>Last staff sign-in</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody id="firms-body"></tbody></table></div><p class="footnote">${firms[0] ? `Estimates use ${money(firms[0].base_monthly_cents)} + ${money(firms[0].staff_monthly_cents)} per active staff member. ` : ""}Actual invoices may include credits, discounts or proration.</p>`;
    function render() {
      const q = document.getElementById("search").value.toLowerCase(),
        status = document.getElementById("status").value;
      const rows = firms.filter(
        (f) =>
          (!status || f.status === status) &&
          [f.name, f.email, f.owner?.name, f.owner?.email].some((v) =>
            String(v || "")
              .toLowerCase()
              .includes(q),
          ),
      );
      document.getElementById("firms-body").innerHTML = rows.length
        ? rows
            .map(
              (f) =>
                `<tr><td><a href="/admin/firms/${f.id}">${esc(f.name)}</a></td><td>${esc(f.owner?.name || f.email)}</td><td>${badge(f.status)}</td><td>${f.seats}</td><td>${f.estimate_cents == null ? "—" : money(f.estimate_cents)}</td><td>${date(f.last_login_at)}</td><td><a class="button" href="/admin/firms/${f.id}">View firm</a></td></tr>`,
            )
            .join("")
        : '<tr><td colspan="7" class="empty">No firms match your search.</td></tr>';
    }
    document.getElementById("search").addEventListener("input", render);
    document.getElementById("status").addEventListener("change", render);
    render();
  }
  async function detail(id) {
    const { firm: f, staff, activity } = await api("/firms/" + id);
    main.innerHTML = `<a href="/admin">Firms</a> <span class="muted"> / ${esc(f.name)}</span><h1>${esc(f.name)} ${badge(f.status)}</h1><p>${esc(f.owner?.name || "No owner")} · ${esc(f.owner?.email || f.email)}</p><div class="split"><section><h2>DarkLion subscription</h2>${f.status === "exempt" ? '<div class="price">Exempt</div><p class="footnote">Legacy firm — not billed for DarkLion.</p>' : f.estimate_cents == null ? `<p>No active subscription. At current staffing it would be ${money(f.base_monthly_cents + f.staff_monthly_cents * f.seats)} / month (${money(f.base_monthly_cents)} + ${f.seats} × ${money(f.staff_monthly_cents)}).</p>` : `<div class="price">${money(f.estimate_cents)} <span>/ month estimated</span></div><div class="line"><span>Base subscription</span><span>${money(f.base_monthly_cents)}</span></div><div class="line"><span>${f.seats} active staff × ${money(f.staff_monthly_cents)}</span><span>${money(f.staff_monthly_cents * f.seats)}</span></div>`}<hr><div class="details"><div class="line"><span>${f.cancel_at_period_end ? "Scheduled cancellation" : "Current period ends"}</span><span>${date(f.current_period_end)}</span></div><div class="line"><span>Seat count</span><span>${f.seats} active · ${f.billed_seats ?? 0} billed</span></div><div class="line"><span>Subscription record updated</span><span>${timestamp(f.billing_updated_at)}</span></div></div><div id="billing"><p>Loading Stripe billing details…</p></div></section><section><form id="support-form" class="panel"><h2>View firm workspace</h2><p>See the workspace as a staff member.</p><label for="staff">View as</label><select id="staff" required>${staff.length ? staff.map((u) => `<option value="${u.id}">${esc(u.name)} · ${esc(u.role)}</option>`).join("") : '<option value="">No active staff</option>'}</select><label for="reason">Reason for access</label><input id="reason" required minlength="5" maxlength="500" placeholder="What are you helping with?"><label for="password">Your current password</label><input id="password" type="password" autocomplete="current-password" required><p class="footnote">Read-only · 30 minutes · Access recorded</p><div id="support-error" role="alert"></div><button class="primary" ${staff.length ? "" : "disabled"}>Start viewing</button><p class="footnote">Your login stays separate. Changes and message read receipts are disabled.</p></form><section class="panel" id="activity"><h2>Recent admin activity</h2>${logMarkup(activity)}</section></section></div>`;
    bindRevokes(document.getElementById("activity"), () => detail(id));
    bindEvents(document.getElementById("activity"));
    document
      .getElementById("support-form")
      .addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = event.target.querySelector("button");
        button.disabled = true;
        const input = {
          firmId: Number(id),
          userId: Number(document.getElementById("staff").value),
          reason: document.getElementById("reason").value,
          password: document.getElementById("password").value,
        };
        try {
          const session = await api("/support-sessions", {
            method: "POST",
            body: JSON.stringify(input),
          });
          sessionStorage.setItem("dl_support_session", JSON.stringify(session));
          location.assign("/crm");
        } catch (e) {
          document.getElementById("support-error").textContent = e.message;
          document.getElementById("support-error").className = "message error";
          button.disabled = false;
        } finally {
          document.getElementById("password").value = "";
        }
      });
    loadBilling(id);
  }
  async function loadBilling(id) {
    const el = document.getElementById("billing");
    try {
      const b = await api("/firms/" + id + "/billing");
      if (!el.isConnected) return;
      el.innerHTML = `${b.dashboardUrl ? `<a class="button" href="${esc(b.dashboardUrl)}" target="_blank" rel="noopener noreferrer">Open in Stripe</a><p class="footnote">Manage payments, refunds and cancellation in Stripe.</p>` : `<div class="message">${esc(b.message)}</div>`}${b.refreshedAt ? `<p>Billing email: ${esc(b.email || "Not available")}<br><small>Stripe checked ${esc(new Date(b.refreshedAt).toLocaleString("en-US", { timeZone: "America/New_York" }))} ET ${b.status ? "· " + esc(labels[b.status] || b.status) : ""}</small></p>` : ""}<h2 class="section">Recent invoices</h2>${b.invoices.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>${b.invoices.map((i) => `<tr><td>${date(i.date * 1000)}</td><td>${money(i.amount, i.currency)}</td><td>${badge(i.status)}</td></tr>`).join("")}</tbody></table></div>` : "<p>No invoices to display.</p>"}`;
    } catch (e) {
      if (el.isConnected) {
        el.innerHTML = `<div class="message error">Billing unavailable. ${esc(e.message)}<br><button id="retry-billing">Retry billing</button></div>`;
        document
          .getElementById("retry-billing")
          .addEventListener("click", () => loadBilling(id));
      }
    }
  }
  async function logs() {
    main.innerHTML = `<h1>Access log</h1><p>Support access across all firms. Times shown in Eastern time.</p><div id="logs">${logMarkup(await api("/access-log"))}</div>`;
    bindRevokes(document.getElementById("logs"), logs);
    bindEvents(document.getElementById("logs"));
  }
  async function init() {
    try {
      const actor = await api("/me");
      document.getElementById("admin-name").textContent = actor.name;
      const isLog = location.pathname === "/admin/access-log";
      document
        .getElementById(isLog ? "nav-log" : "nav-firms")
        .classList.add("active");
      const match = location.pathname.match(/^\/admin\/firms\/(\d+)$/);
      await (match ? detail(match[1]) : isLog ? logs() : directory());
    } catch (e) {
      showError(e);
    }
  }
  document
    .getElementById("admin-sign-out")
    .addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        // Locked tabs have nothing to revoke server-side; clear the login like the workspace does.
        if (adminToken()) await api("/logout", { method: "POST" });
      } catch (e) {
        if (e.code !== "ADMIN_LOCKED") {
          showError(e);
          return;
        }
      }
      localStorage.removeItem("dl_token");
      localStorage.removeItem("dl_firm");
      sessionStorage.removeItem("dl_support_session");
      sessionStorage.removeItem(ADMIN_KEY);
      location.replace("/login?returnTo=/admin");
    });
  init();
})();
