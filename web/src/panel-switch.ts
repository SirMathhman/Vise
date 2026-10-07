/** Header button id -> the dropdown panel it opens. */
const PANELS: Record<string, string> = {
  "tools-btn": "tools-panel",
  "profiles-btn": "profiles-panel",
  "sessions-btn": "sessions-panel",
  "hooks-btn": "hooks-panel",
};

/**
 * Header dropdown panels share one spot, so opening one must close the rest
 * (otherwise a later panel covers an earlier one and hides its controls). The
 * listener runs before the buttons' own toggle handlers, which then open or
 * close the clicked panel as usual.
 */
export function setupPanelSwitch(): void {
  document.querySelector(".bar")?.addEventListener(
    "click",
    (event) => {
      const button = (event.target as HTMLElement).closest("button");
      const own = button ? PANELS[button.id] : undefined;
      if (!own) return;
      for (const id of Object.values(PANELS)) {
        if (id !== own) document.getElementById(id)?.classList.add("hidden");
      }
    },
    true,
  );
}
