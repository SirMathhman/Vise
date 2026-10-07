/**
 * Backend-neutral browser surface. The agent tools and the web UI depend only
 * on this interface, so a Firefox backend (WebDriver BiDi, which has no CDP)
 * can be added later without touching them. The only implementation today is
 * `ChromiumBackend` (Chrome DevTools Protocol).
 */

import type { PageAction } from "./page-scripts.ts";
import type { PageProbe } from "./probe.ts";

/** One open page. `id` is a small stable number the model can quote back. */
export interface TabInfo {
  id: number;
  url: string;
  title: string;
}

/** A user input event forwarded to a tab; coordinates are page CSS pixels. */
export type BrowserInput =
  | {
      kind: "mouse";
      type: "move" | "down" | "up" | "wheel";
      x: number;
      y: number;
      button: "left" | "middle" | "right" | "none";
      clickCount: number;
      deltaX: number;
      deltaY: number;
      modifiers: number;
    }
  | {
      kind: "key";
      type: "down" | "up";
      key: string;
      code: string;
      keyCode: number;
      text: string;
      modifiers: number;
    };

/** One screencast frame: a base64-encoded JPEG of the tab's viewport. */
export type FrameListener = (jpegBase64: string) => void;

/** A JavaScript dialog (alert/confirm/prompt/beforeunload) waiting for an answer. */
export interface DialogInfo {
  type: string;
  message: string;
}

export interface BrowserBackend {
  /** What to tell the model when it lists no tabs, if that needs explaining (e.g. nothing has been shared with it). */
  readonly noTabsHint?: string;
  /** True once the browser has been launched (listing tabs never launches it by itself). */
  readonly running: boolean;
  /** Open a new tab at `url` and wait for it to load. */
  openTab(url: string): Promise<TabInfo>;
  /** All open page tabs. */
  listTabs(): Promise<TabInfo[]>;
  /** Navigate an existing tab and wait for it to load. */
  navigate(id: number, url: string): Promise<TabInfo>;
  /** Outline of the visible interactive elements, each tagged with a ref (e1, e2, ...). */
  snapshot(id: number): Promise<string>;
  /** Click, hover over, or drag between elements named by ref. */
  click(id: number, ref: string): Promise<void>;
  hover(id: number, ref: string): Promise<void>;
  drag(id: number, fromRef: string, toRef: string): Promise<void>;
  /** Type into an element (or the focused one when `ref` is omitted), optionally pressing a key after. */
  typeText(
    id: number,
    ref: string | undefined,
    text: string,
    options: { replace: boolean; key?: string },
  ): Promise<void>;
  /**
   * Put local files (absolute paths) into the file input that element `ref`
   * stands for. Optional: a backend that cannot do it leaves it out.
   */
  uploadFiles?(id: number, ref: string, paths: string[]): Promise<void>;
  /**
   * A PNG screenshot of the tab as base64 (the whole scrollable page when
   * `fullPage`, where the engine can). Optional: a backend that cannot leaves it out.
   */
  screenshot?(id: number, fullPage: boolean): Promise<string>;
  /**
   * Run a page action (see `PageAction` in `page-scripts.ts`) in a tab and
   * return what its script answered. Optional: a backend that cannot leaves it out.
   */
  runPageAction?(id: number, action: PageAction): Promise<unknown>;
  /** The dialog currently blocking a tab, if any. */
  pendingDialog(id: number): DialogInfo | null;
  /** Accept or dismiss the blocking dialog (`promptText` answers a prompt). */
  handleDialog(id: number, accept: boolean, promptText?: string): Promise<void>;
  /** Run a Playwright snippet (`page` in scope) against a tab; returns its JSON result. */
  runCode(id: number, code: string): Promise<string>;
  /** Close a tab. */
  closeTab(id: number): Promise<void>;
  /** The visible text of a tab's page. */
  readText(id: number): Promise<string>;
  /**
   * A cheap look at a tab's page for the wait tools: whether `needle` is on it,
   * and a fingerprint that changes when the page does, computed in the page so
   * each look is a few bytes. Optional: without it the tools read the whole text.
   */
  pageProbe?(id: number, needle?: string): Promise<PageProbe>;
  /**
   * Resize the tab's viewport to `width` x `height` CSS pixels and stream its
   * frames to `onFrame` until the returned function is called.
   */
  startScreencast(
    id: number,
    width: number,
    height: number,
    onFrame: FrameListener,
  ): Promise<() => Promise<void>>;
  /** Forward a mouse or keyboard event to a tab. */
  sendInput(id: number, input: BrowserInput): Promise<void>;
  /**
   * Be told, as text for the model, when the user hands the agent a tab or takes
   * one back (only a backend where the user shares their own browser has this).
   */
  onUserShare?(listener: (message: string) => void): () => void;
  /** Be told when tabs open, close, or change; returns an unsubscribe function. */
  onTabsChanged(listener: () => void): () => void;
  /** Shut the browser down. Safe to call when it never started. */
  close(): Promise<void>;
}
