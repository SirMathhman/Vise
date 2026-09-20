/**
 * The viewer's web-tab subsystem: the two non-file tab kinds and the URL bar
 * that opens them.
 *
 * A `kind: "url"` tab is a plain `<iframe>` — right for a local page (the
 * user's own dev server), where it is crisp, inspectable with real devtools,
 * and free. A `kind: "browser"` tab is the CDP-backed surface in
 * `browserView.ts`: a screencast of the real Chrome page the model's
 * browser_* tools also drive, which is the only thing that works for a remote
 * page, since a cross-origin frame cannot be scripted and most sites refuse
 * to be framed at all. `setupUrlBar` picks between them by host.
 *
 * Split out of `fileTree.ts` to keep that file under the 500-line cap. It
 * depends on `fileTree.ts` only for the `Viewer` type (a type-only import,
 * erased at runtime), so the runtime dependency edge points one way —
 * the same arrangement `treePanel.ts` and `tabsView.ts` use.
 */

import { disposeBrowserView, openBrowserView } from "./browserView.js";
import type { Viewer } from "./fileTree.js";
import { activateTab } from "./tabsView.js";

/**
 * The shared preamble for the two non-file tab kinds (an embedded `<iframe>`
 * URL, and the CDP-backed browser surface): flush the outgoing tab's buffer,
 * open/activate this tab, and reset the viewer chrome so the caller can render
 * into an empty `#viewer-body`. Returns false when a pending save failed — the
 * caller must not proceed, or the edit would be lost.
 */
async function beginWebTab(
  rel: string,
  kind: "url" | "browser",
  viewer: Viewer
): Promise<boolean> {
  // The active file tab's buffer must be flushed before switching (same
  // guard as `viewFile`); web tabs have no buffer of their own.
  const activeIdBefore = viewer.tabStore.activeId();
  if (activeIdBefore !== null) {
    const buffer = viewer.tabBuffers.get(activeIdBefore);
    const saved = buffer ? await buffer.flush() : true;
    if (!saved) return false; // A pending save failed; abort.
  }
  const tabId = viewer.tabStore.open(rel, kind);
  viewer.tabStore.persist();
  // Re-point `viewer.store` at the placeholder (web tabs own no buffer) and
  // re-render the tab bar.
  activateTab(viewer, tabId, viewer.cb);
  viewer.title.textContent = rel;
  viewer.title.title = rel;
  viewer.actions.innerHTML = "";
  // A web tab shows no editor, so any live edit_file diff preview is gone.
  viewer.activeDiff = null;
  // Stop any previously mounted screencast before its canvas is discarded.
  disposeBrowserView();
  // Replace whatever the body holds (an editor, a stale frame, a hint).
  viewer.body.style.overflow = "";
  viewer.body.innerHTML = "";
  return true;
}

/**
 * Open a URL as an embedded tab: an <iframe> fills the viewer body in place
 * of the editor. The frame has no editor buffer: it is read-only, and
 * `closeTab` handles its absence from `tabBuffers` (no flush, no dirty check).
 */
export async function openUrl(rel: string, viewer: Viewer): Promise<void> {
  if (!(await beginWebTab(rel, "url", viewer))) return;
  const frame = document.createElement("iframe");
  frame.className = "url-frame";
  frame.src = rel;
  frame.setAttribute("aria-label", `web page: ${rel}`);
  viewer.body.append(frame);
}

/**
 * Open a URL as the CDP-backed browser tab: a live screencast of the real
 * Chrome page the model's browser_* tools also drive. Used for any page a
 * plain `<iframe>` can't host — which is most of the web, since cross-origin
 * pages can't be scripted and most sites refuse to be framed at all.
 */
export async function openBrowser(rel: string, viewer: Viewer): Promise<void> {
  if (!(await beginWebTab(rel, "browser", viewer))) return;
  openBrowserView(viewer.body, rel, (settled) => {
    // A redirect can land somewhere other than what was typed. Retitle to the
    // settled URL, but only while this tab is still the active one — a slow
    // navigation must not clobber the title of a tab the user switched to.
    const activeTab = viewer.tabStore
      .getTabs()
      .find((t) => t.id === viewer.tabStore.activeId());
    if (activeTab?.rel !== rel) return;
    viewer.title.textContent = settled;
    viewer.title.title = settled;
  });
}

/**
 * The "Open URL" bar above the viewer actions: a persistent button that
 * reveals an input; Enter (or blur-with-text) opens the typed URL as an
 * embedded tab. It lives outside `#viewer-actions` deliberately — that
 * element is cleared wholesale on file navigation (`renderEditor`,
 * `viewFile`, `closeTab`, `activateTab`), so a button inside it would
 * disappear after the first file open.
 */
export function setupUrlBar(viewer: Viewer, bar: HTMLElement): void {
  const btn = bar.querySelector<HTMLButtonElement>("#viewer-url-open");
  const input = bar.querySelector<HTMLInputElement>("#viewer-url-input");
  if (!btn || !input) return;
  btn.addEventListener("click", () => {
    input.hidden = false;
    input.value = "";
    input.focus();
  });
  const submit = (): void => {
    const url = normalizeUrl(input.value);
    if (url === null) {
      input.classList.add("url-invalid");
      return;
    }
    input.classList.remove("url-invalid");
    input.value = "";
    input.hidden = true;
    // A *new* URL has no existing tab, so `viewFile`'s dispatch (which only
    // fires for a pre-existing kind=url/browser tab) would skip it and fall
    // into the file path — persisting the URL as a file tab and 404ing on
    // the URL string. Call the opener directly; it opens the tab, persists,
    // activates, and renders. Re-opening an existing web tab via the tab bar
    // still flows through `viewFile`, where the dispatch works.
    //
    // Local pages get the plain <iframe>: same-origin-ish, crisp text, real
    // DOM and working devtools, and it costs no screencast. Everything else
    // gets the CDP browser surface, because a remote page in an iframe is
    // unscriptable and usually refuses to be framed at all.
    void (isLocalUrl(url) ? openUrl(url, viewer) : openBrowser(url, viewer));
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      input.hidden = true;
      input.value = "";
    }
  });
  input.addEventListener("blur", () => {
    // A non-empty value the user abandoned still opens its tab; an empty one
    // collapses the bar back to its button.
    if (input.value.trim() !== "") {
      submit();
    } else {
      input.hidden = true;
    }
  });
}

/**
 * Normalize a typed URL: bare hostnames (`www.google.com`) get an https
 * scheme; anything `new URL` accepts is returned as typed, else `null`.
 * Only http(s) and file URLs are embedded (about:, javascript:, and other
 * schemes have no meaningful rendered page to pin to a tab).
 */
/**
 * True for a page served from this machine. Those are the ones an `<iframe>`
 * hosts well — typically the user's own dev server, which they want to see
 * crisply and inspect with real devtools.
 */
function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const u = new URL(candidate);
    return u.protocol === "http:" ||
      u.protocol === "https:" ||
      u.protocol === "file:"
      ? candidate
      : null;
  } catch {
    return null;
  }
}
