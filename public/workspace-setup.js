"use strict";
const { api, action, message, token } = window.offer;
if (!token) location.href = "/login";
let importKey = crypto.randomUUID(),
  csv = "",
  checkedCsv = "";
let staffOrder = [];
function renderStaffOrder() {
  const list = document.getElementById('staff-order'); list.replaceChildren();
  staffOrder.forEach((staff, index) => {
    const row=document.createElement('div'), name=staff.display_name || staff.name;
    row.textContent=name+' ';
    for (const [label, direction] of [['Move up',-1],['Move down',1]]) {
      const button=document.createElement('button');button.type='button';button.className='secondary';
      button.textContent=direction<0?'↑':'↓';button.setAttribute('aria-label',label+' '+name);
      button.disabled=index+direction<0 || index+direction>=staffOrder.length;
      button.onclick=()=>{[staffOrder[index],staffOrder[index+direction]]=[staffOrder[index+direction],staffOrder[index]];renderStaffOrder();};
      row.append(button);
    }
    list.append(row);
  });
}
function download(name, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function billing() {
  try {
    const b = await api("/api/subscription");
    document.getElementById("price").textContent =
      `$${(b.monthlyCents / 100).toFixed(0)} / month · ${b.seats} active staff`;
    document.getElementById("billing-state").textContent = b.existingFirm
      ? "Your existing workspace continues under its current arrangement."
      : `${b.status}${b.cancelAtPeriodEnd ? " · Cancels at the end of the billing period" : ""}${b.configured ? "" : " · Billing setup is not available yet."}`;
    document.getElementById("checkout").hidden =
      b.existingFirm ||
      !b.configured ||
      !["unsubscribed", "canceled", "incomplete_expired"].includes(b.status);
    document.getElementById("billing").hidden =
      b.existingFirm || b.status === "unsubscribed";
    document.getElementById("sync-seats").hidden = ![
      "active",
      "trialing",
    ].includes(b.status);
    return b;
  } catch (e) {
    document.getElementById("billing-state").textContent = e.message;
  }
}
// Guide a new firm to payment, and confirm activation after Stripe returns.
async function membershipNotice() {
  const result = new URLSearchParams(location.search).get("billing");
  let b = await billing();
  if (!b || b.existingFirm) return;
  if (result === "success") {
    for (let i = 0; i < 8 && !["active", "trialing"].includes(b?.status); i++) {
      message("Payment received. Activating your membership…");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      b = await billing();
    }
    history.replaceState(null, "", "/workspace-setup");
    message(
      ["active", "trialing"].includes(b?.status)
        ? "Your membership is active. Welcome to DarkLion — invite your team and import your clients below."
        : "Payment received. Your membership is still activating; refresh this page in a minute.",
    );
    return;
  }
  if (["unsubscribed", "canceled", "incomplete_expired"].includes(b.status) && b.configured)
    message(
      (result === "cancelled" ? "Checkout was cancelled. " : "Your workspace is ready. ") +
        "Activate your membership under Your membership to start working with clients.",
    );
}
async function load() {
  const setup = await api("/api/onboarding");
  const p = setup.preferences;
  document.getElementById("workspace-name").textContent = p.name;
  document.getElementById("display-name").value = p.name;
  document.getElementById("contact-email").value = p.contactEmail;
  const timezone = document.getElementById("timezone");
  if (![...timezone.options].some((o) => o.value === p.timezone))
    timezone.add(new Option(p.timezone, p.timezone));
  timezone.value = p.timezone;
  document.getElementById("color").value = p.primaryColor;
  document.getElementById("ai-enabled").checked = p.aiEnabled;
  const staff = await api("/api/staff");
  const saved=p.staffContactOrder.map(id=>staff.find(s=>s.id===id)).filter(Boolean);
  staffOrder=[...saved,...staff.filter(s=>!saved.some(item=>item.id===s.id))];
  renderStaffOrder();
  const routes = await api("/api/firm-settings/notification-routes");
  for (const category of ["tax", "bookkeeping", "other"]) {
    const select = document.getElementById("route-" + category);
    select.replaceChildren(new Option("Owners and administrators", ""));
    for (const s of staff)
      select.add(new Option(s.display_name || s.name, String(s.id)));
    select.value = String(
      routes.find((r) => r.folder_category === category)?.staff_user_id || "",
    );
  }
  await membershipNotice();
  await requests();
}
async function requests() {
  const rows = await api("/api/firm-settings/data-requests");
  const list = document.getElementById("data-requests");
  list.replaceChildren();
  for (const request of rows) {
    const row = document.createElement("div");
    row.textContent = `${request.kind} · ${request.account_kind} account ${request.account_id} · ${new Date(request.created_at).toLocaleDateString()} `;
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Request status");
    for (const s of [
      "requested",
      "reviewing",
      "retained",
      "completed",
      "cancelled",
    ])
      select.add(new Option(s, s));
    select.value = request.status;
    const note = document.createElement("input");
    note.setAttribute("aria-label", "Response or retention explanation");
    note.placeholder = "Response or retention explanation";
    note.value = request.note;
    const button = document.createElement("button");
    button.textContent = "Update request";
    button.onclick = async () => {
      button.disabled = true;
      try {
        await api(
          "/api/firm-settings/data-requests/" + request.id,
          { status: select.value, note: note.value },
          "PUT",
        );
        message("Request updated.");
      } catch (e) {
        message(e.message, true);
      } finally {
        button.disabled = false;
      }
    };
    row.append(select, note, button);
    list.append(row);
  }
}
action("save", async () => {
  await api(
    "/api/firm-settings",
    {
      timezone: document.getElementById("timezone").value,
      aiEnabled: document.getElementById("ai-enabled").checked,
      staffContactOrder: staffOrder.map(staff=>staff.id),
    },
    "PUT",
  );
  await api(
    "/firms/branding",
    {
      display_name: document.getElementById("display-name").value,
      contact_email: document.getElementById("contact-email").value,
      primary_color: document.getElementById("color").value,
    },
    "PUT",
  );
  message("Firm settings saved.");
});
action("invite", async () => {
  const result = await api("/firms/invite", {
    name: document.getElementById("invite-name").value,
    email: document.getElementById("invite-email").value,
    role: document.getElementById("invite-role").value,
  });
  const a = document.createElement("a");
  a.href = result.inviteUrl;
  a.textContent = new URL(result.inviteUrl, location.origin).href;
  document
    .getElementById("invitation-link")
    .replaceChildren("Share this invitation securely: ", a);
});
action("template", async () => {
  const response = await fetch("/api/onboarding/import-template", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!response.ok) throw Error("Could not download template");
  download("darklion-contacts.csv", await response.text(), "text/csv");
});
document.getElementById("csv").onchange = () => {
  checkedCsv = "";
  document.getElementById("import").hidden = true;
  importKey = crypto.randomUUID();
};
action("preview", async () => {
  document.getElementById("import").hidden = true;
  const file = document.getElementById("csv").files[0];
  if (!file || file.size > 500000)
    throw Error("Choose a CSV smaller than 500 KB");
  csv = await file.text();
  const result = await api("/api/onboarding/import", { csv, dryRun: true });
  const output = document.getElementById("import-result");
  output.hidden = false;
  output.textContent = result.valid
    ? `${result.total} valid contacts.\n\n` +
      result.preview
        .map((r) => `${r.first_name} ${r.last_name} · ${r.email}`)
        .join("\n")
    : result.errors.map((e) => `Row ${e.row}: ${e.error}`).join("\n");
  checkedCsv = result.valid ? csv : "";
  document.getElementById("import").hidden = !result.valid;
});
action("import", async () => {
  if (!checkedCsv || checkedCsv !== csv)
    throw Error("Check your file before importing");
  const result = await api("/api/onboarding/import", { csv, key: importKey });
  document.getElementById("import-result").textContent =
    `${result.created} contacts created; ${result.skipped} existing contacts skipped. ${result.relationships} relationships and ${result.companies} companies created.`;
  document.getElementById("import").hidden = true;
  message("Contacts imported. No invitations were sent.");
});
action("save-routes", async () => {
  const routes = ["tax", "bookkeeping", "other"].flatMap((folder_category) => {
    const id = Number(
      document.getElementById("route-" + folder_category).value,
    );
    return id ? [{ folder_category, staff_user_id: id }] : [];
  });
  await api("/api/firm-settings/notification-routes", { routes }, "PUT");
  message("Document notification routes saved.");
});
for (const [id, path] of [
  ["checkout", "checkout"],
  ["billing", "portal"],
])
  action(id, async () => {
    const result = await api("/api/subscription/" + path, {});
    const url = new URL(result.url);
    if (
      url.protocol !== "https:" ||
      !["checkout.stripe.com", "billing.stripe.com"].includes(url.hostname)
    )
      throw Error("Invalid billing destination");
    location.href = url.href;
  });
action("sync-seats", async () => {
  await api("/api/subscription/sync-seats", {});
  await billing();
  message("Staff seats updated.");
});
action("export", async () =>
  download(
    "darklion-workspace.json",
    JSON.stringify(await api("/api/onboarding/export"), null, 2),
    "application/json",
  ),
);
load().catch((e) => message(e.message, true));

async function stripeAccounts() {
  const rows = await api("/api/firm-settings/stripe-accounts");
  const list = document.getElementById("stripe-accounts");
  list.replaceChildren();
  for (const item of rows) {
    const row = document.createElement("div");
    row.textContent = item.label + " · " + item.name;
    list.append(row);
  }
}
action("connect-stripe", async () => {
  const key = document.getElementById("stripe-key");
  try {
    await api(
      "/api/firm-settings/stripe-accounts/" +
        encodeURIComponent(document.getElementById("stripe-name").value),
      { label: document.getElementById("stripe-label").value, key: key.value },
      "PUT",
    );
    message("Stripe account connected.");
    await stripeAccounts();
  } finally {
    key.value = "";
  }
});
stripeAccounts().catch((e) => message(e.message, true));

async function services() {
  const state = await api("/api/firm-settings/services");
  const list = document.getElementById("service-status");
  for (const [key, label] of [
    ["billing", "Subscription billing"],
    ["inference", "Managed AI"],
    ["mobile", "iPhone app"],
  ]) {
    const row = document.createElement("p");
    row.textContent =
      label + ": " + (state.checks[key] ? "Configured" : "Setup pending");
    list.append(row);
  }
  const usage = document.getElementById("ai-usage");
  usage.textContent = state.usage.length
    ? state.usage
        .map(
          (r) =>
            `${r.feature}: ${r.requests} ${r.status} · ${r.input_tokens} input / ${r.output_tokens} output tokens`,
        )
        .join("\n")
    : "No AI requests this month.";
  if (state.jobs.length) {
    const row = document.createElement("p");
    row.textContent =
      "Summary jobs: " +
      state.jobs.map((j) => `${j.count} ${j.status}`).join(", ");
    list.append(row);
  }
}
services().catch((e) => message(e.message, true));
