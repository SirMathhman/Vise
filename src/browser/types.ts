/**
 * Backend-neutral browser surface. The agent tools and the web UI depend only
 * on this interface, so a Firefox backend (WebDriver BiDi, which has no CDP)
 * can be added later without touching them. The only implementation today is
 * `ChromiumBackend` (Chrome DevTools Protocol).
 */

/** One open page. `id` is a small stable number the model can quote back. */
export interface TabInfo {
  id: number;
  url: string;
  title: string;
}

export interface BrowserBackend {
  /** Open a new tab at `url` and wait for it to load. */
  openTab(url: string): Promise<TabInfo>;
  /** All open page tabs. */
  listTabs(): Promise<TabInfo[]>;
  /** Navigate an existing tab and wait for it to load. */
  navigate(id: number, url: string): Promise<TabInfo>;
  /** The visible text of a tab's page. */
  readText(id: number): Promise<string>;
  /** Shut the browser down. Safe to call when it never started. */
  close(): Promise<void>;
}
