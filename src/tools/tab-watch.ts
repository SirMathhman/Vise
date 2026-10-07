import type { BrowserBackend, TabInfo } from "../browser/types.ts";

/**
 * Notices tabs a page opens by itself (a link with `target=_blank`, a
 * `window.open` popup: "Apply on company website" and the like). They are
 * ordinary tabs the agent can use at once, but it would never know they exist,
 * so an action that may open one is bracketed by `mark()` and `opened()`.
 */

/** How long a page gets, after an action, to open its popup (it is usually immediate). */
const SETTLE_MS = 300;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class TabWatcher {
  private seen: Set<number> | null = null;

  constructor(private readonly browser: BrowserBackend) {}

  /** Remember the tabs that are open now (call before the action). */
  async mark(): Promise<void> {
    this.seen = await this.ids();
  }

  /**
   * A note for the model about tabs that appeared since `mark()` ("" when there
   * are none, or when the browser could not be asked).
   */
  async opened(format: (tab: TabInfo) => string): Promise<string> {
    const before = this.seen;
    this.seen = null;
    if (!before) return "";
    await sleep(SETTLE_MS);
    try {
      const fresh = (await this.browser.listTabs()).filter(
        (tab) => !before.has(tab.id),
      );
      return fresh
        .map(
          (tab) =>
            `\n[a new tab opened: ${format(tab)} - use its number with the browser tools; the other tabs are still open]`,
        )
        .join("");
    } catch {
      return "";
    }
  }

  private async ids(): Promise<Set<number> | null> {
    try {
      return new Set((await this.browser.listTabs()).map((tab) => tab.id));
    } catch {
      return null;
    }
  }
}
