"use strict";

// Hamburger menu for phones and tablets; the CSS decides when it is shown.
const siteHeader = document.querySelector(".site-header");
const menuToggle = document.querySelector(".menu-toggle");
function setMenuOpen(open) {
  siteHeader.classList.toggle("menu-open", open);
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
}
siteHeader.classList.add("has-menu");
menuToggle.hidden = false;
menuToggle.addEventListener("click", () =>
  setMenuOpen(!siteHeader.classList.contains("menu-open")),
);
document
  .querySelectorAll(".site-menu a")
  .forEach((link) => link.addEventListener("click", () => setMenuOpen(false)));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && siteHeader.classList.contains("menu-open")) {
    setMenuOpen(false);
    menuToggle.focus();
  }
});

const staffCount = document.getElementById("staff-count");
const priceTotal = document.getElementById("price-total");
const estimateHelp = document.getElementById("estimate-help");

staffCount.addEventListener("input", () => {
  const seats = staffCount.valueAsNumber;
  const valid =
    staffCount.validity.valid &&
    Number.isInteger(seats) &&
    seats >= 1 &&
    seats <= 1000;
  staffCount.setAttribute("aria-invalid", String(!valid));
  estimateHelp.hidden = valid;
  priceTotal.textContent = valid
    ? `${seats} staff ${seats === 1 ? "user" : "users"} = $${(19 + seats * 5).toLocaleString("en-US")}/month`
    : "Estimate unavailable";
});

// Progressive enhancement: all product views remain readable without JavaScript.
const tourControls = document.querySelector(".tour-controls");
const tourButtons = [...tourControls.querySelectorAll("button")];
const tourPanels = tourButtons.map((button) =>
  document.getElementById(button.getAttribute("aria-controls")),
);

function showTourPanel(selectedIndex) {
  tourButtons.forEach((button, index) => {
    const selected = index === selectedIndex;
    button.setAttribute("aria-pressed", String(selected));
    tourPanels[index].hidden = !selected;
  });
}

tourButtons.forEach((button, index) => {
  button.addEventListener("click", () => showTourPanel(index));
});
showTourPanel(0);
tourControls.hidden = false;

// Keep both workspace illustrations available when JavaScript is disabled.
const workspaceControls = document.querySelector(".workspace-controls");
const workspaceButtons = [...workspaceControls.querySelectorAll("button")];
function showWorkspace(selectedIndex) {
  workspaceButtons.forEach((button, index) => {
    const selected = index === selectedIndex;
    button.setAttribute("aria-pressed", String(selected));
    document.getElementById(button.getAttribute("aria-controls")).hidden =
      !selected;
  });
}
workspaceButtons.forEach((button, index) =>
  button.addEventListener("click", () => showWorkspace(index)),
);
showWorkspace(0);
workspaceControls.hidden = false;
