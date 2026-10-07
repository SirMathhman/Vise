import type { PageProbe } from "./probe.ts";
import type {
  BrowserBackend,
  BrowserInput,
  DialogInfo,
  FrameListener,
  TabInfo,
} from "./types.ts";

/**
 * The browser as seen through the Firefox extension: every call is relayed to
 * the extension, which runs it in the user's real browser and only on tabs it
 * has been given (it opened them, or the user handed them over). The transport
 * is an `ExtensionLink`, implemented by the web server (`src/web/ext-hub.ts`),
 * so this module has no network code and `src/browser/` never imports the web
 * layer.
 */

/** A request/response channel to the connected extension. */
export interface ExtensionLink {
  /** Whether an extension is connected right now. */
  readonly connected: boolean;
  /** Run an operation in the extension; rejects with its error message. */
  call(op: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Be told when the extension's tabs change or it connects/disconnects. */
  onEvent(listener: () => void): () => void;
}

const NO_LIVE_VIEW =
  "the Firefox extension works in your real browser window, so there is no live view";

/** Drives the user's own Firefox through the Vise extension. */
export class ExtensionBackend implements BrowserBackend {
  constructor(private readonly link: ExtensionLink) {}

  /** The tabs here are only the ones the user shared, so an empty list needs explaining. */
  readonly noTabsHint =
    "Vise can only see tabs the user shares with it, and none are shared yet. Ask the user to open the Vise sidebar in Firefox, switch to the page in question and press 'Give Vise this tab' (the sidebar's banner must say 'Connected to this tab'). Or open a new tab yourself with browser_open.";

  get running(): boolean {
    return this.link.connected;
  }

  private async tab<T>(
    op: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return (await this.link.call(op, params)) as T;
  }

  openTab(url: string): Promise<TabInfo> {
    return this.tab("openTab", { url });
  }

  listTabs(): Promise<TabInfo[]> {
    return this.tab("listTabs", {});
  }

  navigate(id: number, url: string): Promise<TabInfo> {
    return this.tab("navigate", { tab: id, url });
  }

  snapshot(id: number): Promise<string> {
    return this.tab("snapshot", { tab: id });
  }

  async click(id: number, ref: string): Promise<void> {
    await this.tab("click", { tab: id, ref });
  }

  async hover(id: number, ref: string): Promise<void> {
    await this.tab("hover", { tab: id, ref });
  }

  async drag(id: number, fromRef: string, toRef: string): Promise<void> {
    await this.tab("drag", { tab: id, from: fromRef, to: toRef });
  }

  async typeText(
    id: number,
    ref: string | undefined,
    text: string,
    options: { replace: boolean; key?: string },
  ): Promise<void> {
    await this.tab("typeText", { tab: id, ref, text, ...options });
  }

  /** The extension answers page dialogs itself (a page's script cannot be held for the agent). */
  pendingDialog(): DialogInfo | null {
    return null;
  }

  handleDialog(): Promise<void> {
    return Promise.reject(
      new Error(
        "dialogs are answered automatically in the Firefox extension (alert accepted, confirm declined, prompt cancelled)",
      ),
    );
  }

  runCode(): Promise<string> {
    return Promise.reject(
      new Error("browser_run_code is not supported in the Firefox extension"),
    );
  }

  async closeTab(id: number): Promise<void> {
    await this.tab("closeTab", { tab: id });
  }

  readText(id: number): Promise<string> {
    return this.tab("readText", { tab: id });
  }

  pageProbe(id: number, needle?: string): Promise<PageProbe> {
    return this.tab("probe", { tab: id, needle });
  }

  startScreencast(
    _id: number,
    _width: number,
    _height: number,
    _onFrame: FrameListener,
  ): Promise<() => Promise<void>> {
    return Promise.reject(new Error(NO_LIVE_VIEW));
  }

  async sendInput(_id: number, _input: BrowserInput): Promise<void> {
    // nothing to forward: the user works in the real window
  }

  onTabsChanged(listener: () => void): () => void {
    return this.link.onEvent(listener);
  }

  /** The browser belongs to the user: there is nothing for Vise to shut down. */
  async close(): Promise<void> {}
}
