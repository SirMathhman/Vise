/**
 * The scope context bar at the top of the settings page. Shows which project
 * folder is connected (or that none is), so the user always knows whether
 * the tabs below them are project- or global-scoped.
 */
export function renderScopeContext(root: string | null, el: HTMLElement): void {
  el.textContent = "";
  if (root === null) {
    el.textContent = "No folder connected";
  } else {
    el.textContent = `Project: ${root}`;
    el.title = root;
  }
}
