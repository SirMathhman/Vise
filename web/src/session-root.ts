/**
 * The session's root folder: shown in the top bar, and fixed for the life of
 * the page (the server binds a connection to the root it was opened with).
 * "open folder…" asks the server to show the operating system's folder chooser
 * (a web page cannot learn a folder's absolute path itself) and opens the chosen
 * folder as a new session in this tab (the page reloads onto it; the old
 * conversation stays auto-saved and the explorer is read-only).
 */
/** The page address for a session rooted at `root` (or "none"); the sidebar mode carries over. */
function sessionUrl(root: string): string {
  const query = new URLSearchParams({ root });
  const ui = new URLSearchParams(window.location.search).get("ui");
  if (ui) query.set("ui", ui);
  return `/?${query.toString()}`;
}

export function setupSessionRoot(
  button: HTMLButtonElement,
  noFolderButton: HTMLButtonElement,
  label: HTMLElement,
): (path: string) => void {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const res = await fetch("/api/pick-folder", { method: "POST" });
      const body = (await res.json()) as { path?: string | null };
      if (body.path) {
        window.location.assign(sessionUrl(body.path));
      }
    } finally {
      button.disabled = false;
    }
  });
  // A session with no working directory at all (no file or shell tools).
  noFolderButton.addEventListener("click", () => {
    window.location.assign(sessionUrl("none"));
  });
  return (path) => {
    if (path === "") {
      label.textContent = "no folder";
      label.title =
        "This session has no working directory, so it has no file or shell tools.";
      return;
    }
    label.textContent = path;
    label.title = `This session is fixed to ${path}. Open the ☰ menu to start a new session in a different folder.`;
  };
}
