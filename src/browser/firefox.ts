import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { dataDir } from "../data-dir.ts";
import { BidiConnection } from "./bidi.ts";
import * as actions from "./bidi-actions.ts";
import { dispatchInput, startScreencast } from "./bidi-view.ts";
import {
  killBrowsersUsing,
  removeProfile,
  sweepStaleProfiles,
} from "./processes.ts";
import type {
  BrowserBackend,
  BrowserInput,
  DialogInfo,
  FrameListener,
  TabInfo,
} from "./types.ts";

/** Firefox install locations (forward slashes work for Windows paths). */
const CANDIDATES = [
  "C:/Program Files/Mozilla Firefox/firefox.exe",
  "C:/Program Files (x86)/Mozilla Firefox/firefox.exe",
];

const LOAD_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 20_000;
const TITLE_TIMEOUT_MS = 1_500;

/** Where Firefox records the port of its BiDi server once it is listening. */
const PORT_FILE = "WebDriverBiDiServer.json";

/** Quiet a throwaway profile: no first-run pages, telemetry or update checks. */
const USER_JS = [
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
  'user_pref("app.update.auto", false);',
  'user_pref("browser.aboutwelcome.enabled", false);',
].join("\n");

/** How a Firefox backend gets its browser: attach to a port, or launch its own. */
export interface FirefoxOptions {
  /** Attach to a Firefox started with `--remote-debugging-port`; absent: launch one. */
  port?: number;
}

/** Whether a Firefox install is present (the launch would fail without one). */
export function findFirefox(): string | undefined {
  return CANDIDATES.find((path) => existsSync(path));
}

/**
 * Drives Firefox over WebDriver BiDi. By default it launches a headless Firefox
 * with a private profile under `.vise/` and kills it on `close()`; with a port
 * it attaches to a Firefox the user started and leaves that browser running.
 * `browser_run_code` is unsupported (Playwright cannot drive a stock Firefox).
 */
export class FirefoxBackend implements BrowserBackend {
  private launching: Promise<BidiConnection> | null = null;
  private profile: string | null = null;
  private readonly tabs = new Map<number, string>();
  private nextTabId = 1;
  private readonly changeListeners = new Set<() => void>();
  /** The blank tab a launched Firefox starts with; never shown to the agent or the UI. */
  private startupContexts = new Set<string>();
  /** Dialogs waiting for an answer, by tab; they block a tab's script until handled. */
  private readonly dialogs = new Map<string, DialogInfo>();
  private readonly dialogWaiters = new Set<(context: string) => void>();

  constructor(private readonly options: FirefoxOptions = {}) {}

  get running(): boolean {
    return this.launching !== null;
  }

  async openTab(url: string): Promise<TabInfo> {
    const bidi = await this.connection();
    const { context } = await bidi.send<{ context: string }>(
      "browsingContext.create",
      { type: "tab" },
    );
    const id = this.register(context);
    return this.navigate(id, url);
  }

  async listTabs(): Promise<TabInfo[]> {
    const bidi = await this.connection();
    const { contexts } = await bidi.send<{
      contexts: { context: string; url: string }[];
    }>("browsingContext.getTree", {});
    const pages = contexts.filter((c) => !this.startupContexts.has(c.context));
    const live = new Set(pages.map((c) => c.context));
    for (const [id, context] of this.tabs) {
      if (!live.has(context)) this.tabs.delete(id);
    }
    return Promise.all(
      pages.map(async (page) => ({
        id: this.idFor(page.context) ?? this.register(page.context),
        url: page.url,
        title: await this.title(bidi, page.context),
      })),
    );
  }

  async navigate(id: number, url: string): Promise<TabInfo> {
    const bidi = await this.connection();
    const context = this.context(id);
    const loaded = bidi.send("browsingContext.navigate", {
      context,
      url,
      wait: "complete",
    });
    loaded.catch(() => undefined);
    // A page that never finishes loading still returns after the timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), LOAD_TIMEOUT_MS);
    });
    try {
      await Promise.race([loaded, late]);
    } finally {
      clearTimeout(timer);
    }
    return this.info(bidi, id);
  }

  async snapshot(id: number): Promise<string> {
    const outline = await this.inTab(id, (bidi, context) =>
      actions.snapshot(bidi, context),
    );
    return outline ?? "(a dialog opened while reading the page)";
  }

  async click(id: number, ref: string): Promise<void> {
    await this.inTab(id, (bidi, context) => actions.click(bidi, context, ref));
  }

  async hover(id: number, ref: string): Promise<void> {
    await this.inTab(id, (bidi, context) => actions.hover(bidi, context, ref));
  }

  async drag(id: number, fromRef: string, toRef: string): Promise<void> {
    await this.inTab(id, (bidi, context) =>
      actions.drag(bidi, context, fromRef, toRef),
    );
  }

  async typeText(
    id: number,
    ref: string | undefined,
    text: string,
    options: { replace: boolean; key?: string },
  ): Promise<void> {
    await this.inTab(id, (bidi, context) =>
      actions.typeText(bidi, context, ref, text, options),
    );
  }

  pendingDialog(id: number): DialogInfo | null {
    const context = this.tabs.get(id);
    return (context && this.dialogs.get(context)) || null;
  }

  async handleDialog(
    id: number,
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    const bidi = await this.connection();
    const context = this.context(id);
    await bidi.send("browsingContext.handleUserPrompt", {
      context,
      accept,
      ...(promptText === undefined ? {} : { userText: promptText }),
    });
    this.dialogs.delete(context);
  }

  runCode(): Promise<string> {
    return Promise.reject(
      new Error("browser_run_code is not supported with Firefox"),
    );
  }

  async closeTab(id: number): Promise<void> {
    const bidi = await this.connection();
    await bidi.send("browsingContext.close", { context: this.context(id) });
    this.tabs.delete(id);
  }

  async readText(id: number): Promise<string> {
    const bidi = await this.connection();
    const text = await actions.evalJson<string>(
      bidi,
      this.context(id),
      "document.body ? document.body.innerText : ''",
    );
    return text ?? "";
  }

  async startScreencast(
    id: number,
    width: number,
    height: number,
    onFrame: FrameListener,
  ): Promise<() => Promise<void>> {
    const bidi = await this.connection();
    return startScreencast(bidi, this.context(id), width, height, onFrame);
  }

  async sendInput(id: number, input: BrowserInput): Promise<void> {
    const bidi = await this.connection();
    await dispatchInput(bidi, this.context(id), input);
  }

  onTabsChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async close(): Promise<void> {
    const launching = this.launching;
    this.launching = null;
    this.tabs.clear();
    this.dialogs.clear();
    if (launching) {
      try {
        const bidi = await launching;
        // An attached Firefox belongs to the user: disconnect and leave it running.
        if (this.options.port === undefined) {
          await bidi.send("browser.close").catch(() => undefined);
        }
        bidi.close();
      } catch {
        // the browser never came up; nothing to close
      }
    }
    this.shutdown();
  }

  /** Kill the launched Firefox (matched by its private profile) and delete the profile. */
  private shutdown(): void {
    if (!this.profile) return;
    killBrowsersUsing(basename(this.profile));
    removeProfile(this.profile);
    this.profile = null;
  }

  private context(id: number): string {
    const context = this.tabs.get(id);
    if (!context) throw new Error(`no such tab: ${id}`);
    return context;
  }

  private idFor(context: string): number | undefined {
    for (const [id, known] of this.tabs) {
      if (known === context) return id;
    }
    return undefined;
  }

  private register(context: string): number {
    const id = this.nextTabId++;
    this.tabs.set(id, context);
    return id;
  }

  /** The tab's title; empty while a dialog blocks its script. */
  private async title(bidi: BidiConnection, context: string): Promise<string> {
    if (this.dialogs.has(context)) return "";
    const read = actions
      .evalJson<string>(bidi, context, "document.title")
      .catch(() => "");
    const late = new Promise<string>((resolve) =>
      setTimeout(() => resolve(""), TITLE_TIMEOUT_MS),
    );
    return (await Promise.race([read, late])) ?? "";
  }

  private async info(bidi: BidiConnection, id: number): Promise<TabInfo> {
    const context = this.context(id);
    const url =
      (await actions
        .evalJson<string>(bidi, context, "location.href")
        .catch(() => "")) ?? "";
    return { id, url, title: await this.title(bidi, context) };
  }

  /**
   * Run a page action on a tab. Refuses while a dialog blocks the tab, and
   * returns as soon as an action opens one (the action would otherwise hang
   * until the dialog is answered).
   */
  private async inTab<T>(
    id: number,
    run: (bidi: BidiConnection, context: string) => Promise<T>,
  ): Promise<T | undefined> {
    const bidi = await this.connection();
    const context = this.context(id);
    const blocked = this.dialogs.get(context);
    if (blocked) {
      throw new Error(
        `a ${blocked.type} dialog is open ("${blocked.message}"): call browser_handle_dialog first`,
      );
    }
    let release = (): void => undefined;
    const opened = new Promise<undefined>((resolve) => {
      const waiter = (opening: string): void => {
        if (opening === context) resolve(undefined);
      };
      this.dialogWaiters.add(waiter);
      release = () => this.dialogWaiters.delete(waiter);
    });
    const running = run(bidi, context);
    running.catch(() => undefined);
    try {
      return await Promise.race([running, opened]);
    } finally {
      release();
    }
  }

  private trackDialogs(bidi: BidiConnection): void {
    bidi.on("browsingContext.userPromptOpened", (params) => {
      const context = String(params["context"]);
      this.dialogs.set(context, {
        type: String(params["type"]),
        message: String(params["message"]),
      });
      for (const waiter of this.dialogWaiters) waiter(context);
    });
    bidi.on("browsingContext.userPromptClosed", (params) => {
      this.dialogs.delete(String(params["context"]));
    });
  }

  /** Remember the startup tab (launched only), then turn context events into tab-change notifications. */
  private async watchTabs(bidi: BidiConnection): Promise<void> {
    if (this.options.port === undefined) {
      const { contexts } = await bidi.send<{ contexts: { context: string }[] }>(
        "browsingContext.getTree",
        {},
      );
      this.startupContexts = new Set(contexts.map((c) => c.context));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const listener of this.changeListeners) listener();
      }, 100);
    };
    for (const event of [
      "browsingContext.contextCreated",
      "browsingContext.contextDestroyed",
      "browsingContext.load",
    ]) {
      bidi.on(event, notify);
    }
  }

  private connection(): Promise<BidiConnection> {
    this.launching ??= this.connect().catch((error: unknown) => {
      // A failed launch must not poison later attempts.
      this.launching = null;
      this.shutdown();
      throw error;
    });
    return this.launching;
  }

  private async connect(): Promise<BidiConnection> {
    const port = this.options.port ?? (await this.launch());
    const bidi = await BidiConnection.connect(`ws://127.0.0.1:${port}/session`);
    this.trackDialogs(bidi);
    await this.watchTabs(bidi);
    return bidi;
  }

  /** Start a headless Firefox on a private profile; resolves with its BiDi port. */
  private async launch(): Promise<number> {
    const exe = findFirefox();
    if (!exe) throw new Error("Firefox is not installed");
    sweepStaleProfiles();
    const profile = join(dataDir, `browser-profile-${process.pid}-firefox`);
    this.profile = profile;
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "user.js"), USER_JS);
    spawn(
      exe,
      [
        "--headless",
        "--remote-debugging-port=0",
        "--profile",
        profile,
        "--no-remote",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    process.once("exit", () => this.shutdown());
    return readPort(join(profile, PORT_FILE));
  }
}

/** Wait for Firefox to record its BiDi port in the profile. */
async function readPort(file: string): Promise<number> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      try {
        const port = (
          JSON.parse(readFileSync(file, "utf8")) as { ws_port?: number }
        ).ws_port;
        if (port) return port;
      } catch {
        // the file is still being written
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Firefox did not start (no WebDriver BiDi port)");
}
