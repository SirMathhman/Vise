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

export function createContext(rootPath: string): AppContext {
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
    fileWatcher,
    browserSession,
    firefoxBridge,
  };
}
