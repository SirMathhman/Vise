import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { dataDir } from "../data-dir.ts";
import { CdpConnection } from "./cdp.ts";
import { dispatchInput, startScreencast } from "./cdp-view.ts";
import type {
  BrowserBackend,
  BrowserInput,
  FrameListener,
  TabInfo,
} from "./types.ts";

/** Chromium-family browsers, in preference order (Edge ships with Windows 11). */
const CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/** Browser-owned pages (welcome, sync prompts, devtools) are not the agent's tabs. */
const BROWSER_INTERNAL = /^(edge|chrome|devtools|chrome-extension):\/\//;

const LOAD_TIMEOUT_MS = 15_000;
const LAUNCH_TIMEOUT_MS = 15_000;

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
}

interface Tab {
  targetId: string;
  sessionId: string;
}

/**
 * Drives a real Chromium over CDP. The browser is launched lazily on first use
 * (headless, with a private profile under `.vise/`) and killed on `close()`
 * or process exit.
 */
export class ChromiumBackend implements BrowserBackend {
  private launching: Promise<CdpConnection> | null = null;
  /** The launched process is only a stub; the real browser pid comes from CDP. */
  private browserPid: number | null = null;
  /** Private per-launch profile, so a stale browser can never lock it. */
  private profile: string | null = null;
  private readonly tabs = new Map<number, Tab>();
  private nextTabId = 1;
  private readonly changeListeners = new Set<() => void>();
  /** The blank tab the browser starts with; never shown to the agent or the UI. */
  private startupTargets = new Set<string>();

  get running(): boolean {
    return this.launching !== null;
  }

  async openTab(url: string): Promise<TabInfo> {
    const cdp = await this.connection();
    const { targetId } = await cdp.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    const id = await this.attach(cdp, targetId);
    return this.navigate(id, url);
  }

  async listTabs(): Promise<TabInfo[]> {
    const cdp = await this.connection();
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    const pages = targetInfos.filter(
      (t) =>
        t.type === "page" &&
        !this.startupTargets.has(t.targetId) &&
        !BROWSER_INTERNAL.test(t.url),
    );
    const live = new Set(pages.map((t) => t.targetId));
    for (const [id, tab] of this.tabs) {
      if (!live.has(tab.targetId)) this.tabs.delete(id);
    }
    const out: TabInfo[] = [];
    for (const page of pages) {
      const id =
        this.idFor(page.targetId) ?? (await this.attach(cdp, page.targetId));
      out.push({ id, url: page.url, title: page.title });
    }
    return out;
  }

  async navigate(id: number, url: string): Promise<TabInfo> {
    const cdp = await this.connection();
    const tab = this.tab(id);
    const loaded = this.waitForLoad(cdp, tab.sessionId);
    const result = await cdp.send<{ errorText?: string }>(
      "Page.navigate",
      { url },
      tab.sessionId,
    );
    if (result.errorText) throw new Error(result.errorText);
    await loaded;
    return this.info(cdp, id);
  }

  async closeTab(id: number): Promise<void> {
    const cdp = await this.connection();
    await cdp.send("Target.closeTarget", { targetId: this.tab(id).targetId });
    this.tabs.delete(id);
  }

  async readText(id: number): Promise<string> {
    const cdp = await this.connection();
    const { result } = await cdp.send<{ result: { value?: string } }>(
      "Runtime.evaluate",
      {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      },
      this.tab(id).sessionId,
    );
    return result.value ?? "";
  }

  async startScreencast(
    id: number,
    width: number,
    height: number,
    onFrame: FrameListener,
  ): Promise<() => Promise<void>> {
    const cdp = await this.connection();
    return startScreencast(cdp, this.tab(id).sessionId, width, height, onFrame);
  }

  async sendInput(id: number, input: BrowserInput): Promise<void> {
    const cdp = await this.connection();
    await dispatchInput(cdp, this.tab(id).sessionId, input);
  }

  onTabsChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  async close(): Promise<void> {
    const launching = this.launching;
    this.launching = null;
    this.tabs.clear();
    if (launching) {
      try {
        const cdp = await launching;
        await cdp.send("Browser.close").catch(() => undefined);
        cdp.close();
      } catch {
        // the browser never came up; nothing to close
      }
    }
    this.shutdown();
  }

  /** Kill the whole browser process tree (it spawns helpers) and delete its profile. */
  private shutdown(): void {
    const pid = this.browserPid;
    this.browserPid = null;
    if (pid !== null) {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
    }
    if (this.profile) {
      try {
        rmSync(this.profile, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch {
        // a helper still holds a file; the stale profile is harmless
      }
    }
    this.profile = null;
  }

  private tab(id: number): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`no such tab: ${id}`);
    return tab;
  }

  private idFor(targetId: string): number | undefined {
    for (const [id, tab] of this.tabs) {
      if (tab.targetId === targetId) return id;
    }
    return undefined;
  }

  private async attach(cdp: CdpConnection, targetId: string): Promise<number> {
    const { sessionId } = await cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      { targetId, flatten: true },
    );
    await cdp.send("Page.enable", {}, sessionId);
    const id = this.nextTabId++;
    this.tabs.set(id, { targetId, sessionId });
    return id;
  }

  private async info(cdp: CdpConnection, id: number): Promise<TabInfo> {
    const { targetInfo } = await cdp.send<{ targetInfo: TargetInfo }>(
      "Target.getTargetInfo",
      { targetId: this.tab(id).targetId },
    );
    return { id, url: targetInfo.url, title: targetInfo.title };
  }

  /** Resolves when the tab fires `load`, or after a timeout (slow pages still return). */
  private waitForLoad(cdp: CdpConnection, sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const off = cdp.on("Page.loadEventFired", (_params, session) => {
        if (session !== sessionId) return;
        off();
        clearTimeout(timer);
        resolve();
      });
      const timer = setTimeout(() => {
        off();
        resolve();
      }, LOAD_TIMEOUT_MS);
    });
  }

  /** Remember the startup tab, then turn target events into tab-change notifications. */
  private async watchTargets(cdp: CdpConnection): Promise<void> {
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>(
      "Target.getTargets",
    );
    this.startupTargets = new Set(
      targetInfos.filter((t) => t.type === "page").map((t) => t.targetId),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const listener of this.changeListeners) listener();
      }, 100);
    };
    for (const event of [
      "Target.targetCreated",
      "Target.targetInfoChanged",
      "Target.targetDestroyed",
    ]) {
      cdp.on(event, notify);
    }
    await cdp.send("Target.setDiscoverTargets", { discover: true });
  }

  private connection(): Promise<CdpConnection> {
    this.launching ??= this.launch().catch((error: unknown) => {
      // A failed launch must not poison later attempts.
      this.launching = null;
      this.shutdown();
      throw error;
    });
    return this.launching;
  }

  private async launch(): Promise<CdpConnection> {
    const exe = CANDIDATES.find((path) => existsSync(path));
    if (!exe) {
      throw new Error("no Chromium-family browser found (Edge or Chrome)");
    }
    sweepStaleProfiles();
    const profile = join(dataDir, `browser-profile-${process.pid}`);
    this.profile = profile;
    mkdirSync(profile, { recursive: true });
    const portFile = join(profile, "DevToolsActivePort");
    rmSync(portFile, { force: true });
    spawn(
      exe,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        // A fresh profile must not pick up the user's OS account (Edge signs in implicitly).
        "--disable-sync",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    process.once("exit", () => this.shutdown());
    const [port, path] = await readPortFile(portFile);
    const cdp = await CdpConnection.connect(`ws://127.0.0.1:${port}${path}`);
    const { processInfo } = await cdp.send<{
      processInfo: { id: number; type: string }[];
    }>("SystemInfo.getProcessInfo");
    this.browserPid = processInfo.find((p) => p.type === "browser")?.id ?? null;
    await this.watchTargets(cdp);
    return cdp;
  }
}

/** Wait for the browser to write DevToolsActivePort (line 1: port, line 2: browser WS path). */
async function readPortFile(file: string): Promise<[string, string]> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const [port, path] = readFileSync(file, "utf8").split(/\r?\n/);
      if (port && path) return [port, path];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("browser did not start (no DevToolsActivePort)");
}

/** True when a process with this pid is running. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove profiles left by Vise processes that are no longer running. */
function sweepStaleProfiles(): void {
  if (!existsSync(dataDir)) return;
  for (const name of readdirSync(dataDir)) {
    const pid = Number(name.replace("browser-profile-", ""));
    if (!name.startsWith("browser-profile-") || isAlive(pid)) continue;
    try {
      rmSync(join(dataDir, name), { recursive: true, force: true });
    } catch {
      // a straggler helper still holds a file; try again next launch
    }
  }
}
