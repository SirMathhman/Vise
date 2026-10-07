/**
 * The session's root folder: shown in the top bar, and fixed for the life of
 * the page (the server binds a connection to the root it was opened with).
 * "open folder…" asks the server to show the operating system's folder chooser
 * (a web page cannot learn a folder's absolute path itself) and opens the chosen
 * folder as a new session in this tab (the page reloads onto it; the old
 * conversation stays auto-saved and the explorer is read-only).
 */
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
        window.location.assign(`/?root=${encodeURIComponent(body.path)}`);
      }
    } finally {
      button.disabled = false;
    }
  });
  // A session with no working directory at all (no file or shell tools).
  noFolderButton.addEventListener("click", () => {
    window.location.assign("/?root=none");
  });
  return (path) => {
    if (path === "") {
      label.textContent = "no folder";
      label.title =
        "This session has no working directory, so it has no file or shell tools.";
      return;
    }
    label.textContent = path;
    label.title = `This session is fixed to ${path}. Use "open folder…" to start a new session in a different folder.`;
  };
}
