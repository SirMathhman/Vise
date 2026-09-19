import { createBrowserSession } from "./routes/browser.js";
import { createFileWatcher } from "./watch.js";

export type FileWatcher = ReturnType<typeof createFileWatcher>;
export type BrowserSession = ReturnType<typeof createBrowserSession>;

export interface AppContext {
  now: () => Date;
  rootPath: string;
  /** The app-owned filesystem watcher, started and closed with the app. */
  fileWatcher: FileWatcher;
  /**
   * The app-owned model-driven browser session (Playwright), lazily opened on
   * the first browser_open and closed with the app. Owning it here — rather
   * than in a module-level singleton — keeps the app's long-lived resources
   * visible in one place, matching the fileWatcher above.
   */
  browserSession: BrowserSession;
}

export function createContext(rootPath: string): AppContext {
  const fileWatcher = createFileWatcher(rootPath);
  const browserSession = createBrowserSession();
  return { now: () => new Date(), rootPath, fileWatcher, browserSession };
}
