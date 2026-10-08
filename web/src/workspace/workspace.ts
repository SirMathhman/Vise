import { createBrowserView } from "./browser-view.ts";
import { createExplorer } from "./explorer.ts";
import { pairWithExtension } from "./pairing.ts";
import { rememberRoot } from "./restore-root.ts";
import { setupSessionRoot } from "./session-root.ts";
import type { BrowserTab } from "./open-tabs.ts";

/** The slice of a server message the workspace reacts to. */
interface WorkspaceMessage {
  type: string;
  path?: string;
  tab?: number;
  tabs?: BrowserTab[];
  data?: string;
  message?: string;
  noFolder?: boolean;
  badRoot?: string;
}

function el<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

/**
 * The left-hand workspace: file tree, tabs, file/markdown/URL viewers and the
 * integrated browser's live view. Owns its DOM and the server messages that
 * keep it current (project-tree changes and browser tabs/frames).
 */
export function createWorkspace(
  send: (msg: Record<string, unknown>) => void,
  renderMarkdown: (source: string) => string,
  onError: (text: string) => void,
): {
  toggle(): void;
  /** Ask the server for the browser's current tabs. */
  sync(): void;
  /** Handle a server message; false when it is not the workspace's. */
  handle(message: WorkspaceMessage): boolean;
} {
  const root = el<HTMLElement>("workspace");
  // In the Firefox extension's sidebar the browser is the user's own window: no file tree or live view.
  const sidebar = new URLSearchParams(location.search).get("ui") === "sidebar";
  if (sidebar) {
    document.body.classList.add("sidebar");
    pairWithExtension();
    root.classList.add("hidden");
  }
  // A session with no working directory has no project tree to list.
  let noFolder = false;
  const listProject = (): void => {
    if (!noFolder) void explorer.open("");
  };
  const showRoot = setupSessionRoot(
    el<HTMLButtonElement>("open-folder-btn"),
    el<HTMLButtonElement>("no-folder-btn"),
    el<HTMLElement>("root-label"),
  );
  const browser = createBrowserView(
    el<HTMLElement>("files-browser"),
    el<HTMLImageElement>("files-browser-img"),
    send,
  );
  const explorer = createExplorer(
    el<HTMLElement>("files-path"),
    el<HTMLUListElement>("files-list"),
    el<HTMLElement>("files-tabs"),
    el<HTMLPreElement>("files-viewer"),
    {
      mdView: el<HTMLElement>("files-md"),
      frame: el<HTMLIFrameElement>("files-frame"),
      urlForm: el<HTMLFormElement>("files-url-form"),
      addrForm: el<HTMLFormElement>("files-addr-form"),
      modeBtn: el<HTMLButtonElement>("files-mode"),
      pane: el<HTMLElement>("files-browser"),
      browser,
      svg: el<HTMLElement>("files-svg"),
      svgImg: el<HTMLImageElement>("files-svg-img"),
      renderMarkdown,
    },
  );

  return {
    toggle() {
      root.classList.toggle("hidden");
      if (!root.classList.contains("hidden")) listProject();
    },
    sync: () => send({ type: "browser_tabs" }),
    handle(message) {
      if (sidebar && message.type.startsWith("browser_")) return true;
      switch (message.type) {
        case "root":
          showRoot(message.path ?? "");
          rememberRoot(message.path ?? "");
          if (message.badRoot) {
            onError(`folder not available, so no folder: ${message.badRoot}`);
          }
          noFolder = message.noFolder === true;
          document.body.classList.toggle("no-folder", noFolder);
          // The server serves a root only once a session is open on it, so list the project now.
          if (noFolder) root.classList.add("hidden");
          else if (!root.classList.contains("hidden")) listProject();
          return true;
        case "fs_changed":
          void explorer.reload();
          return true;
        case "browser_tabs":
          // The agent opening a tab brings the workspace up so the user sees it.
          if (explorer.syncBrowserTabs(message.tabs ?? [])) {
            root.classList.remove("hidden");
            listProject();
          }
          return true;
        case "browser_frame":
          browser.frame(message.tab ?? -1, message.data ?? "");
          return true;
        case "browser_error":
          onError(`browser: ${message.message ?? "error"}`);
          return true;
        default:
          return false;
      }
    },
  };
}
