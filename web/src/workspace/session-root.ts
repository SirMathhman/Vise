/**
 * The session's root folder: shown in the top bar, and fixed for the life of
 * the page (the server binds a connection to the root it was opened with).
 * Session → Open folder… asks the server to show the operating system's
 * folder chooser (a web page cannot learn a folder's absolute path itself) and
 * opens the chosen folder as a new session in this tab (the page reloads onto
 * it; the old conversation stays auto-saved).
 */
/** The page address for a session rooted at `root` (or "none"); the sidebar mode carries over. */
function sessionUrl(root: string): string {
  const query = new URLSearchParams({ root });
  const ui = new URLSearchParams(window.location.search).get("ui");
  if (ui) query.set("ui", ui);
  return `/?${query.toString()}`;
}

let picking = false;

/** Ask for a folder and open it as a new session (nothing happens when the chooser is cancelled). */
export async function pickFolder(): Promise<void> {
  if (picking) return;
  picking = true;
  try {
    const res = await fetch("/api/pick-folder", { method: "POST" });
    const body = (await res.json()) as { path?: string | null };
    if (body.path) window.location.assign(sessionUrl(body.path));
  } finally {
    picking = false;
  }
}

/** Open a new session with no working directory at all (no file or shell tools). */
export function openNoFolder(): void {
  window.location.assign(sessionUrl("none"));
}

/** The last part of a path, for the top bar (the whole path is in the tooltip). */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** Show the session's folder in `label`; returns the function the `root` message calls. */
export function setupSessionRoot(label: HTMLElement): (path: string) => void {
  return (path) => {
    if (path === "") {
      label.textContent = "No folder";
      label.title =
        "This session has no working directory, so it has no file or shell tools. Session → Open folder… starts one in a folder.";
      return;
    }
    label.textContent = folderName(path);
    label.title = `${path}\nThis session is fixed to this folder. Session → Open folder… starts one in another.`;
  };
}
