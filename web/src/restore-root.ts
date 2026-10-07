/**
 * Which project folder a page is on. A web page starts with no folder unless its
 * address names one (`?root=`), so a reload keeps it, because the address does.
 * A page opened without one (a fresh visit, or the Firefox extension's sidebar,
 * whose address is always the same) goes back to the folder last chosen in this
 * browser: it is remembered when the server confirms a folder (`rememberRoot`)
 * and put back into the address here, before the page connects.
 *
 * Imported (through `workspace.ts`) before `app.ts` runs, so it acts before anything
 * connects: when it redirects, it then holds the module graph back for good (a
 * top-level `await` that never resolves), so the page being left never opens a
 * connection, and no throwaway session is created on the server.
 */

const KEY = "vise-root";
export const NO_FOLDER = "none";

/** What was last chosen: a folder's path, "none", or nothing yet. */
function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // storage can be blocked; then nothing is remembered
  }
}

/** Remember the folder the server confirmed (`""` for none). */
export function rememberRoot(path: string): void {
  try {
    localStorage.setItem(KEY, path === "" ? NO_FOLDER : path);
  } catch {
    // not remembering is fine
  }
}

const params = new URLSearchParams(location.search);
const saved = remembered();
if (!params.has("root") && saved && saved !== NO_FOLDER) {
  params.set("root", saved);
  location.replace(`${location.pathname}?${params.toString()}`);
  await new Promise<never>(() => undefined);
}
