/**
 * The session's root folder: shown in the top bar, and fixed for the life of
 * the page (the server binds a connection to the root it was opened with).
 * "open folder…" asks the server to show the operating system's folder chooser
 * (a web page cannot learn a folder's absolute path itself) and opens the chosen
 * folder as a new session in a new tab, leaving this one where it is.
 */
export function setupSessionRoot(
  button: HTMLButtonElement,
  label: HTMLElement,
): (path: string) => void {
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const res = await fetch("/api/pick-folder", { method: "POST" });
      const body = (await res.json()) as { path?: string | null };
      if (body.path) {
        window.open(`/?root=${encodeURIComponent(body.path)}`, "_blank");
      }
    } finally {
      button.disabled = false;
    }
  });
  return (path) => {
    label.textContent = path;
    label.title = `This session is fixed to ${path}. Use "open folder…" to start another session in a different folder.`;
  };
}
