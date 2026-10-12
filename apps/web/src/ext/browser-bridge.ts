import { parseSettings } from "@vise/backend";
import type { SwitchableBrowser } from "@vise/backend";
import type { BrowserBackend, BrowserInput } from "@vise/backend";

/**
 * Per-connection bridge between one browser tab's WebSocket and the shared
 * integrated browser: tab-list pushes, the live screencast of the tab being
 * watched, and forwarded input. Wire protocol (JSON):
 *   browser → server: { type:"browser_tabs" }                     list tabs
 *                     { type:"browser_watch", tab, width, height } start/replace the live view
 *                     { type:"browser_unwatch" }
 *                     { type:"browser_input", tab, input }
 *                     { type:"browser_navigate", tab, url }
 *                     { type:"browser_close", tab }
 *                     { type:"browser_settings_get" }
 *                     { type:"browser_settings_set", engine, firefoxPort? }  switch engine (all connections are told)
 *   server → browser: { type:"browser_tabs", tabs }
 *                     { type:"browser_frame", tab, data }          base64 JPEG
 *                     { type:"browser_settings", engine, firefoxPort?, firefoxFound }
 *                     { type:"browser_error", message }
 */

type Send = (msg: Record<string, unknown>) => void;

const MIN_SIZE = 100;
const MAX_SIZE = 4000;

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampSize(value: unknown): number {
  return Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, num(value, 800))));
}

/** Validate an untrusted input payload from the browser; null when malformed. */
export function parseInput(raw: unknown): BrowserInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r["kind"] === "mouse") {
    const type = r["type"];
    const button = r["button"];
    if (
      type !== "move" &&
      type !== "down" &&
      type !== "up" &&
      type !== "wheel"
    ) {
      return null;
    }
    if (
      button !== "left" &&
      button !== "middle" &&
      button !== "right" &&
      button !== "none"
    ) {
      return null;
    }
    return {
      kind: "mouse",
      type,
      x: num(r["x"]),
      y: num(r["y"]),
      button,
      clickCount: num(r["clickCount"]),
      deltaX: num(r["deltaX"]),
      deltaY: num(r["deltaY"]),
      modifiers: num(r["modifiers"]),
    };
  }
  if (r["kind"] === "key") {
    const type = r["type"];
    if (type !== "down" && type !== "up") return null;
    return {
      kind: "key",
      type,
      key: String(r["key"] ?? ""),
      code: String(r["code"] ?? ""),
      keyCode: num(r["keyCode"]),
      text: String(r["text"] ?? ""),
      modifiers: num(r["modifiers"]),
    };
  }
  return null;
}

export class BrowserBridge {
  private stopWatching: (() => Promise<void>) | null = null;
  private watchedTab: number | null = null;
  private readonly offTabs: () => void;
  private readonly offSettings: () => void;
  private readonly offBeforeSwitch: () => void;

  /** `settings` (the shared switchable browser) enables the engine-settings messages. */
  constructor(
    private readonly browser: BrowserBackend,
    private readonly send: Send,
    private readonly settings?: SwitchableBrowser,
  ) {
    this.offTabs = browser.onTabsChanged(() => void this.pushTabs());
    this.offSettings =
      settings?.onSettingsChanged(() => this.pushSettings()) ?? (() => {});
    // The live view belongs to the browser about to be closed: let go of it first.
    this.offBeforeSwitch =
      settings?.onBeforeSwitch(() => this.unwatch()) ?? (() => {});
  }

  /** Release the screencast and the tab-change subscription. */
  async dispose(): Promise<void> {
    this.offTabs();
    this.offSettings();
    this.offBeforeSwitch();
    await this.unwatch();
  }

  /** Handle a `browser_*` message; false when the message is not one of ours. */
  async handle(msg: Record<string, unknown>): Promise<boolean> {
    const type = msg["type"];
    if (typeof type !== "string" || !type.startsWith("browser_")) return false;
    try {
      await this.dispatch(type, msg);
    } catch (error) {
      this.send({
        type: "browser_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  private async dispatch(
    type: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const tab = num(msg["tab"], -1);
    if (type === "browser_tabs") await this.pushTabs();
    else if (type === "browser_settings_get") this.pushSettings();
    else if (type === "browser_settings_set") await this.setSettings(msg);
    else if (type === "browser_unwatch") await this.unwatch();
    else if (type === "browser_watch") {
      await this.watch(tab, clampSize(msg["width"]), clampSize(msg["height"]));
    } else if (type === "browser_input") {
      const input = parseInput(msg["input"]);
      if (input) await this.browser.sendInput(tab, input);
    } else if (type === "browser_close") {
      await this.browser.closeTab(tab);
    } else if (type === "browser_navigate" && typeof msg["url"] === "string") {
      await this.browser.navigate(tab, msg["url"]);
    }
  }

  private pushSettings(): void {
    const settings = this.settings;
    if (!settings) return;
    this.send({
      type: "browser_settings",
      ...settings.settings,
      firefoxFound: settings.firefoxFound,
    });
  }

  private async setSettings(msg: Record<string, unknown>): Promise<void> {
    const parsed = parseSettings(msg);
    if (typeof parsed === "string") throw new Error(parsed);
    const error = await this.settings?.configure(parsed);
    if (error) throw new Error(error);
  }

  /** Push the tab list; an unlaunched browser has none and must not be started just to ask. */
  private async pushTabs(): Promise<void> {
    const tabs = this.browser.running ? await this.browser.listTabs() : [];
    this.send({ type: "browser_tabs", tabs });
    if (
      this.watchedTab !== null &&
      !tabs.some((t) => t.id === this.watchedTab)
    ) {
      await this.unwatch();
    }
  }

  private async watch(
    tab: number,
    width: number,
    height: number,
  ): Promise<void> {
    await this.unwatch();
    this.watchedTab = tab;
    this.stopWatching = await this.browser.startScreencast(
      tab,
      width,
      height,
      (data) => this.send({ type: "browser_frame", tab, data }),
    );
  }

  private async unwatch(): Promise<void> {
    const stop = this.stopWatching;
    this.stopWatching = null;
    this.watchedTab = null;
    await stop?.();
  }
}
