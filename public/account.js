"use strict";
const { api, action, message, portal, token, signOut } = window.offer;
// Client mode has no readable token (HttpOnly session cookie); the first request answers 401
// without a session, and api() then sends the visitor to sign in.
if (!token && !portal) location.href = "/login";
const base = portal ? "/portal/account-security" : "/api/account-security";
let recoveryCodes = [];
const wordmark = document.getElementById("wordmark");
if (portal) {
  document.getElementById("workspace-link").hidden = true;
  document.getElementById("return-link").href = "/portal";
  document.getElementById("return-link").textContent = "Back to portal";
  wordmark.textContent = "Client Portal";
  wordmark.href = "/portal";
} else {
  wordmark.textContent = "DarkLion";
  document.title = "Account security · DarkLion";
}
async function load() {
  const state = await api(base);
  document.getElementById("mfa-state").textContent = state.mfaEnabled
    ? `Enabled. ${state.recoveryCodesRemaining} recovery codes remaining.`
    : state.mfaRequired
      ? "Your firm requires an authenticator before you can access the workspace."
      : "Add a second step to protect your account.";
  document.getElementById("setup").hidden = state.mfaEnabled;
  const sessions = document.getElementById("sessions");
  sessions.replaceChildren();
  for (const session of state.sessions) {
    const row = document.createElement("div");
    row.textContent = `${session.device_label || "Signed-in device"}${session.id === state.currentSessionId ? " · This session" : ""} · ${new Date(session.created_at).toLocaleString()} `;
    const button = document.createElement("button");
    button.className = "secondary";
    button.textContent = "Sign out";
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(base + "/sessions/" + session.id, null, "DELETE");
        if (session.id === state.currentSessionId) signOut();
        else await load();
      } catch (e) {
        message(e.message, true);
        button.disabled = false;
      }
    };
    row.append(button);
    sessions.append(row);
  }
  if (!state.sessions.length)
    sessions.textContent =
      "This older session is not listed. Sign out all devices to require a fresh sign-in.";
  await loadRequests();
}
async function loadRequests() {
  const rows = await api(base + "/data-requests");
  const list = document.getElementById("requests");
  list.replaceChildren();
  for (const item of rows) {
    const row = document.createElement("div");
    row.textContent = `${item.kind} · ${item.status} · ${new Date(item.created_at).toLocaleDateString()}${item.note ? " — " + item.note : ""}`;
    list.append(row);
  }
}
action("begin", async () => {
  const data = await api(base + "/mfa/setup", {
    password: document.getElementById("password").value,
  });
  document.getElementById("password").value = "";
  document.getElementById("setup").hidden = true;
  document.getElementById("confirm").hidden = false;
  document.getElementById("secret").textContent = data.secret;
  document.getElementById("authenticator-link").href = data.uri;
});
action("enable", async () => {
  const data = await api(base + "/mfa/enable", {
    code: document.getElementById("code").value.trim(),
  });
  recoveryCodes = data.recoveryCodes;
  document.getElementById("confirm").hidden = true;
  document.getElementById("recovery").hidden = false;
  document.getElementById("recovery-codes").textContent =
    recoveryCodes.join("\n");
  document.getElementById("mfa-state").textContent =
    "Authenticator enabled. Save your recovery codes before signing in again.";
});
action("download-codes", async () => {
  const url = URL.createObjectURL(
    new Blob(
      [(portal ? "Recovery codes" : "DarkLion recovery codes") + " — keep private\n\n" + recoveryCodes.join("\n")],
      { type: "text/plain" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = portal ? "recovery-codes.txt" : "darklion-recovery-codes.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
action("signin", async () => signOut());
action("change-password", async () => {
  const current = document.getElementById("current-password");
  const next = document.getElementById("new-password");
  await api(base + "/password", {
    currentPassword: current.value,
    newPassword: next.value,
  });
  current.value = "";
  next.value = "";
  message("Password changed. Please sign in again.");
  setTimeout(signOut, 1500);
});
const ADDRESS_INPUTS = {
  address_line1: "address-line1",
  address_line2: "address-line2",
  city: "address-city",
  state: "address-state",
  zip: "address-zip",
};
async function loadProfile() {
  const profile = await api(base + "/profile");
  for (const [field, id] of Object.entries(ADDRESS_INPUTS))
    document.getElementById(id).value = profile.address?.[field] || "";
  document.getElementById("email-note").textContent = profile.email
    ? `You sign in with ${profile.email}. To change it, message your team.`
    : "";
  document.getElementById("address-card").hidden = false;
}
if (portal) loadProfile().catch(() => {});
action("save-address", async () => {
  const body = {};
  for (const [field, id] of Object.entries(ADDRESS_INPUTS))
    body[field] = document.getElementById(id).value;
  await api(base + "/profile/address", body, "PUT");
  message("Address saved.");
});
action("revoke-all", async () => {
  await api(base + "/sessions/revoke-all", {});
  signOut();
});
action("request", async () => {
  const result = await api(base + "/data-requests", {
    kind: document.getElementById("request-kind").value,
    note: document.getElementById("request-note").value,
  });
  message(result.message);
  await loadRequests();
});
load().catch((e) => message(e.message, true));
