import { createFirefoxBridge } from "./routes/browser/firefox/bridge.js";
import { createFirefoxSession } from "./routes/browser/firefox/session.js";
import { createRoutedSession } from "./routes/browser/routed.js";
import { createBrowserSession } from "./routes/browser/session.js";
import { createFileWatcher } from "./watch.js";

export type FileWatcher = ReturnType<typeof createFileWatcher>;
export type BrowserSession = ReturnType<typeof createBrowserSession>;
export type FirefoxBridge = ReturnType<typeof createFirefoxBridge>;

export interface AppContext {
  now: () => Date;
  rootPath: string;
  /**
   * The directory the backend serves the built frontend from (see
   * routes/static.ts). Undefined in dev, where the Vite dev server serves
   * the frontend itself; set for a production / Electron deployment so a
   * single origin serves the SPA alongside /api.
   */
  staticDir?: string;
  /**
   * The upstream an /llm/* request is forwarded to (see routes/llmForward.ts).
   * Defaults to the local llama.cpp proxy on :8080. Undefined only if the
   * caller explicitly passes null, in which case /llm/* returns 502 so a
   * misconfiguration is visible rather than silently 404'ing.
   */
  llmUpstream?: string;
  /** The app-owned filesystem watcher, started and closed with the app. */
  fileWatcher: FileWatcher;
  /**
   * The app-owned model-driven browser session (Playwright), lazily opened on
   * the first browser_open and closed with the app. Owning it here — rather
   * than in a module-level singleton — keeps the app's long-lived resources
   * visible in one place, matching the fileWatcher above. It routes the
   * model's browser tools to the user's Firefox while the Firefox extension
   * is attached (see routed.ts), and to this headless Chrome page otherwise.
   */
  browserSession: BrowserSession;
  /** The link to the Firefox extension (see routes/browser/firefox/bridge.ts). */
  firefoxBridge: FirefoxBridge;
}

export interface CreateContextOptions {
  staticDir?: string;
  llmUpstream?: string | null;
}

export function createContext(
  rootPath: string,
  options: CreateContextOptions = {}
): AppContext {
  const fileWatcher = createFileWatcher(rootPath);
  const firefoxBridge = createFirefoxBridge();
  const browserSession = createRoutedSession(
    createBrowserSession(),
    createFirefoxSession(firefoxBridge),
    firefoxBridge
  );
  return {
    now: () => new Date(),
    rootPath,
    staticDir: options.staticDir,
    llmUpstream:
      options.llmUpstream === null
        ? undefined
        : (options.llmUpstream ?? "http://127.0.0.1:8080"),
    fileWatcher,
    browserSession,
    firefoxBridge,
  };
}
