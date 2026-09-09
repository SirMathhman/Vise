import "./style.css";
import { renderApp, renderBreadcrumb } from "./render.js";
import { loadListing } from "./listing.js";

const appEl = document.querySelector("#app");
renderApp(appEl);

const listingEl = document.querySelector("#listing");
const breadcrumbEl = document.querySelector("#breadcrumb");

function navigate(path) {
  renderBreadcrumb(breadcrumbEl, path);
  loadListing(listingEl, path);
}

// Delegate clicks on directory links and breadcrumb links
appEl.addEventListener("click", (e) => {
  const link = e.target.closest("a[data-path]");
  if (!link) return;
  e.preventDefault();
  navigate(link.dataset.path);
});

navigate("");
