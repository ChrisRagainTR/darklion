"use strict";
const { api, message } = window.offer;
let configuration;
const invitation = new URLSearchParams(location.search).get("invitation");
async function start() {
  configuration = await api("/enrollment/configuration");
  if (!configuration.open) {
    message(
      "New signups are paused. Ask the administrator for an invitation.",
    );
    return;
  }
  if (!invitation) {
    document.getElementById("start-form").hidden = false;
    return;
  }
  let data;
  try {
    data = await api(
      "/enrollment/invitation/" + encodeURIComponent(invitation),
    );
  } catch (_) {
    message(
      "This signup link has expired or was already used. Enter your email for a new link, or sign in if you already created your workspace.",
      true,
    );
    document.getElementById("start-form").hidden = false;
    return;
  }
  document.getElementById("join-steps").hidden = true;
  document.getElementById("invited-email").textContent =
    "Owner account: " + data.email;
  document.getElementById("terms-link").href = configuration.termsUrl;
  document.getElementById("privacy-link").href = configuration.privacyUrl;
  document.getElementById("join-form").hidden = false;
}
document.getElementById("start-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = document.getElementById("start");
  button.disabled = true;
  try {
    const data = await api("/enrollment/start", {
      email: document.getElementById("start-email").value,
    });
    document.getElementById("start-form").hidden = true;
    message(
      "Check " +
        data.email +
        " for your DarkLion signup link. It can take a minute to arrive; check spam if you don't see it.",
    );
  } catch (err) {
    message(err.message, true);
    button.disabled = false;
  }
};
document.getElementById("join-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = document.getElementById("create");
  button.disabled = true;
  try {
    const data = await api("/enrollment", {
      token: invitation,
      name: document.getElementById("name").value,
      ownerName: document.getElementById("owner-name").value,
      slug: document.getElementById("slug").value,
      password: document.getElementById("password").value,
      acceptTerms: document.getElementById("terms").checked,
      termsVersion: configuration.termsVersion,
    });
    location.href = "/login?firm=" + encodeURIComponent(data.firm.slug);
  } catch (err) {
    message(err.message, true);
    button.disabled = false;
  }
};
start().catch((e) => message(e.message, true));
