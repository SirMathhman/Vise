import "./style.css";
import { renderApp, renderChildren } from "./render.js";
import { fetchEntries, loadRoot } from "./listing.js";

const appEl = document.querySelector("#app");
renderApp(appEl);

const treeEl = document.querySelector("#tree");

// Delegate clicks on directory toggles
appEl.addEventListener("click", async (e) => {
  const toggle = e.target.closest(".toggle");
  if (!toggle) return;
  e.preventDefault();

  const li = toggle.closest("li.dir");
  const path = li.dataset.path;
  const expanded = toggle.getAttribute("aria-expanded") === "true";

  if (expanded) {
    // Collapse: remove children
    const children = li.querySelector(":scope > ul.children");
    if (children) children.remove();
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▸";
  } else {
    // Expand: load children if not already present
    let children = li.querySelector(":scope > ul.children");
    if (!children) {
      toggle.textContent = "…";
      try {
        const entries = await fetchEntries(path);
        renderChildren(li, entries, path);
      } catch (err) {
        toggle.textContent = "✕";
        return;
      }
    }
    toggle.setAttribute("aria-expanded", "true");
    toggle.textContent = "▾";
  }
});

loadRoot(treeEl);
