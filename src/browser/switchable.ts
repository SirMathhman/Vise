import type { PageAction } from "./page-scripts.ts";
import { ChromiumBackend } from "./chromium/chromium.ts";
import { findFirefox, FirefoxBackend } from "./firefox/firefox.ts";
import { textProbe, type PageProbe } from "./probe.ts";
import type { BrowserSettings, BrowserSettingsStore } from "./settings.ts";
import type {
  BrowserBackend,
  BrowserInput,
  DialogInfo,
  FrameListener,
  TabInfo,
} from "./types.ts";

/** The engine the settings name, not yet launched. */
function createBackend(settings: BrowserSettings): BrowserBackend {
  return settings.engine === "firefox"
    ? new FirefoxBackend({ port: settings.firefoxPort })
    : new ChromiumBackend();
}

/**
 * The one browser the web server shares, with an engine that can be changed
 * while it runs: every call goes to the current backend, and `configure`
 * closes it (its tabs are lost) and starts over with the new engine. Tab-change
 * listeners survive a switch and are told when it happens.
 */
export class SwitchableBrowser implements BrowserBackend {
  private inner: BrowserBackend;
  private offInner: () => void;
  private current: BrowserSettings;
  private readonly tabListeners = new Set<() => void>();
  private readonly settingsListeners = new Set<() => void>();
  private readonly beforeSwitch = new Set<() => Promise<void> | void>();
  /** Switches run one at a time, in the order they were asked for. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    initial: BrowserSettings,
    private readonly store?: BrowserSettingsStore,
    private readonly create: (
      settings: BrowserSettings,
    ) => BrowserBackend = createBackend,
  ) {
    this.current = initial;
    this.inner = this.create(initial);
    this.offInner = this.inner.onTabsChanged(() => this.notifyTabs());
  }

  get settings(): BrowserSettings {
    return this.current;
  }

  /** Whether a Firefox install exists (for the settings UI). */
  get firefoxFound(): boolean {
    return findFirefox() !== undefined;
  }

  /**
   * Switch engine/port: close the running browser, persist, and tell listeners.
   * Returns an error message or null. Calls are serialized, and asking for the
   * settings already in effect does nothing (it would only close the tabs).
   */
  configure(next: BrowserSettings): Promise<string | null> {
    const run = this.queue.then(() => this.apply(next));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Be told just before the browser is closed by a switch (views of it must let go first). */
  onBeforeSwitch(listener: () => Promise<void> | void): () => void {
    this.beforeSwitch.add(listener);
    return () => this.beforeSwitch.delete(listener);
  }

  private async apply(next: BrowserSettings): Promise<string | null> {
    if (
      next.engine === this.current.engine &&
      next.firefoxPort === this.current.firefoxPort
    ) {
      return null;
    }
    const saveError = this.store?.save(next) ?? null;
    if (saveError) return `could not save the browser settings: ${saveError}`;
    for (const listener of this.beforeSwitch) await listener();
    const old = this.inner;
    this.offInner();
    this.current = next;
    this.inner = this.create(next);
    this.offInner = this.inner.onTabsChanged(() => this.notifyTabs());
    await old.close();
    for (const listener of this.settingsListeners) listener();
    this.notifyTabs();
    return null;
  }

  /** Be told when the settings change; returns an unsubscribe function. */
  onSettingsChanged(listener: () => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  private notifyTabs(): void {
    for (const listener of this.tabListeners) listener();
  }

  get running(): boolean {
    return this.inner.running;
  }
  openTab(url: string): Promise<TabInfo> {
    return this.inner.openTab(url);
  }
  listTabs(): Promise<TabInfo[]> {
    return this.inner.listTabs();
  }
  navigate(id: number, url: string): Promise<TabInfo> {
    return this.inner.navigate(id, url);
  }
  snapshot(id: number): Promise<string> {
    return this.inner.snapshot(id);
  }
  click(id: number, ref: string): Promise<void> {
    return this.inner.click(id, ref);
  }
  uploadFiles(id: number, ref: string, paths: string[]): Promise<void> {
    const inner = this.inner;
    return inner.uploadFiles
      ? inner.uploadFiles(id, ref, paths)
      : Promise.reject(new Error("this browser engine cannot upload files"));
  }
  runPageAction(id: number, action: PageAction): Promise<unknown> {
    const inner = this.inner;
    return inner.runPageAction
      ? inner.runPageAction(id, action)
      : Promise.reject(
          new Error("this browser engine cannot run page actions"),
        );
  }
  screenshot(id: number, fullPage: boolean): Promise<string> {
    const inner = this.inner;
    return inner.screenshot
      ? inner.screenshot(id, fullPage)
      : Promise.reject(
          new Error("this browser engine cannot take screenshots"),
        );
  }
  hover(id: number, ref: string): Promise<void> {
    return this.inner.hover(id, ref);
  }
  drag(id: number, fromRef: string, toRef: string): Promise<void> {
    return this.inner.drag(id, fromRef, toRef);
  }
  typeText(
    id: number,
    ref: string | undefined,
    text: string,
    options: { replace: boolean; key?: string },
  ): Promise<void> {
    return this.inner.typeText(id, ref, text, options);
  }
  pendingDialog(id: number): DialogInfo | null {
    return this.inner.pendingDialog(id);
  }
  handleDialog(
    id: number,
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    return this.inner.handleDialog(id, accept, promptText);
  }
  runCode(id: number, code: string): Promise<string> {
    return this.inner.runCode(id, code);
  }
  closeTab(id: number): Promise<void> {
    return this.inner.closeTab(id);
  }
  readText(id: number): Promise<string> {
    return this.inner.readText(id);
  }
  async pageProbe(id: number, needle?: string): Promise<PageProbe> {
    const inner = this.inner;
    return inner.pageProbe
      ? inner.pageProbe(id, needle)
      : textProbe(await inner.readText(id), needle);
  }
  startScreencast(
    id: number,
    width: number,
    height: number,
    onFrame: FrameListener,
  ): Promise<() => Promise<void>> {
    return this.inner.startScreencast(id, width, height, onFrame);
  }
  sendInput(id: number, input: BrowserInput): Promise<void> {
    return this.inner.sendInput(id, input);
  }
  onTabsChanged(listener: () => void): () => void {
    this.tabListeners.add(listener);
    return () => this.tabListeners.delete(listener);
  }
  close(): Promise<void> {
    return this.inner.close();
  }
}
