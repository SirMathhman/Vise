import { config } from "../../config.ts";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { BrowserBackend, TabInfo } from "../../browser/types.ts";
import {
  SCROLL_DIRECTIONS,
  scrollSummary,
  selectedOrThrow,
  type ScrollDirection,
} from "../../browser/page-scripts.ts";
import { waitHandlers } from "./browser-wait.ts";
import { TabWatcher } from "./tab-watch.ts";
import { describeImage, type ImageOutbox } from "../images.ts";
import { errStr } from "../files.ts";
import { isTooLarge, truncateInline, type TempStore } from "../temp-store.ts";

type Handler = (
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<string>;

function formatTab(tab: TabInfo): string {
  return `tab ${tab.id}: ${tab.title || "(untitled)"} - ${tab.url}`;
}

/** Only web pages (and the blank page) may be opened; no file: or javascript: URLs. */
function checkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const url = value.trim();
  if (url === "about:blank") return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function tabId(args: Record<string, unknown>): number | null {
  const id = args["tab"];
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

/** The element outline is always shown in full, so it is bounded here (its script already stops at 200 elements). */

function clip(outline: string): string {
  return outline.length <= config.maxOutlineChars
    ? outline
    : `${outline.slice(0, config.maxOutlineChars)}
[... outline cut at ${config.maxOutlineChars} characters]`;
}

/** Run a browser action, turning any failure into the tool's `error:` string. */
async function guarded(action: () => Promise<string>): Promise<string> {
  try {
    return await action();
  } catch (err) {
    return errStr(err);
  }
}

function str(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The absolute paths of the files to upload; each must exist and be a file. */
async function uploadPaths(value: unknown, cwd?: string): Promise<string[]> {
  const given = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  if (given.length === 0 || given.some((p) => typeof p !== "string" || !p)) {
    throw new Error("'paths' must list at least one file path");
  }
  const paths: string[] = [];
  for (const raw of given as string[]) {
    if (!cwd && !isAbsolute(raw)) {
      throw new Error(
        `${raw}: there is no working directory, use an absolute path`,
      );
    }
    const path = cwd ? resolve(cwd, raw) : raw;
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`${path} is not a file`);
    paths.push(path);
  }
  return paths;
}

/** Attach the files at `paths` to the file input behind `ref`. */
async function upload(
  browser: BrowserBackend,
  id: number,
  ref: string,
  paths: unknown,
  cwd?: string,
): Promise<string> {
  if (!browser.uploadFiles) throw new Error("this browser cannot upload files");
  const files = await uploadPaths(paths, cwd);
  await browser.uploadFiles(id, ref, files);
  return `uploaded ${files.length} file${files.length === 1 ? "" : "s"}`;
}

/** The required string argument 'text'. */
function text(args: Record<string, unknown>): string {
  const value = str(args, "text");
  if (!value) throw new Error("'text' is required");
  return value;
}

/** The required element ref argument (named `name`). */
function ref(args: Record<string, unknown>, name = "ref"): string {
  const value = str(args, name);
  if (!value) throw new Error(`'${name}' is required (e.g. "e3")`);
  return value;
}

/** Scroll the page (or the area around `args.ref`) the way `args.direction` says. */
async function scroll(
  browser: BrowserBackend,
  id: number,
  args: Record<string, unknown>,
): Promise<string> {
  if (!browser.runPageAction) throw new Error("this browser cannot scroll");
  const direction = String(args["direction"] ?? "") as ScrollDirection;
  if (!SCROLL_DIRECTIONS.includes(direction)) {
    throw new Error(
      `'direction' must be one of ${SCROLL_DIRECTIONS.join(", ")}`,
    );
  }
  const ref = str(args, "ref");
  const amount =
    typeof args["amount"] === "number" ? args["amount"] : undefined;
  const result = await browser.runPageAction(id, {
    name: "scroll",
    ref,
    direction,
    amount,
  });
  return scrollSummary(
    direction,
    result as Parameters<typeof scrollSummary>[1],
    ref,
  );
}

/** Choose the option(s) named in `args` in the drop-down behind `ref`. */
async function select(
  browser: BrowserBackend,
  id: number,
  ref: string,
  args: Record<string, unknown>,
): Promise<string> {
  if (!browser.runPageAction) {
    throw new Error("this browser cannot choose drop-down options");
  }
  const wanted = Array.isArray(args["options"])
    ? args["options"].map(String)
    : args["option"] !== undefined
      ? [String(args["option"])]
      : [];
  if (wanted.length === 0) throw new Error("'option' is required");
  const result = await browser.runPageAction(id, {
    name: "select",
    ref,
    wanted,
  });
  const chosen = selectedOrThrow(
    ref,
    result as Parameters<typeof selectedOrThrow>[1],
  );
  return `selected ${chosen.map((c) => JSON.stringify(c)).join(", ")}`;
}

/** Take a screenshot of a tab and put it in the outbox for the model. */
async function screenshot(
  browser: BrowserBackend,
  images: ImageOutbox | undefined,
  id: number,
  args: Record<string, unknown>,
): Promise<string> {
  const fullPage = args["full_page"] === true;
  if (!browser.screenshot || !images) {
    throw new Error("this browser cannot take screenshots");
  }
  const png = Buffer.from(await browser.screenshot(id, fullPage), "base64");
  return `screenshot of ${describeImage(images.add(png, `tab ${id}`))}`;
}

/** Appended to an action's result when it left a JavaScript dialog open. */
function dialogNote(browser: BrowserBackend, id: number): string {
  const dialog = browser.pendingDialog(id);
  return dialog
    ? `\n[a ${dialog.type} dialog is open: "${dialog.message}" - call browser_handle_dialog]`
    : "";
}

/**
 * Validate `tab`, run `action`, and report `done` plus any dialog it opened.
 * With `watch`, also tell the model about tabs the action made the page open.
 */
function tabRunner(browser: BrowserBackend) {
  const watcher = new TabWatcher(browser);
  return (
    args: Record<string, unknown>,
    action: (id: number) => Promise<string | void>,
    done: string,
    watch = false,
  ): Promise<string> =>
    guarded(async () => {
      const id = tabId(args);
      if (id === null) return "error: an integer 'tab' is required";
      if (watch) await watcher.mark();
      const out = (await action(id)) ?? done;
      const popups = watch ? await watcher.opened(formatTab) : "";
      return `${out}${dialogNote(browser, id)}${popups}`;
    });
}

/**
 * Edge handlers for the browser tools, bound to one `BrowserBackend`. They
 * depend only on the backend-neutral interface, so swapping in another
 * browser engine does not change them.
 */
export function makeBrowserHandlers(
  browser: BrowserBackend,
  /** Where a long page's text is saved; without one it is cut to the limits instead. */
  temp?: TempStore,
  /** What relative upload paths are resolved against; without one they must be absolute. */
  cwd?: string,
  /** Where a screenshot goes so the model sees it. */
  images?: ImageOutbox,
): Record<string, Handler> {
  const onTab = tabRunner(browser);
  return {
    browser_open: (args) =>
      guarded(async () => {
        const url = checkUrl(args["url"]);
        if (!url) return "error: browser_open needs an http(s) 'url'";
        return formatTab(await browser.openTab(url));
      }),
    browser_tabs: () =>
      guarded(async () => {
        const tabs = await browser.listTabs();
        return tabs.length === 0
          ? `no tabs open${browser.noTabsHint ? `. ${browser.noTabsHint}` : ""}`
          : tabs.map(formatTab).join("\n");
      }),
    browser_navigate: (args) =>
      guarded(async () => {
        const id = tabId(args);
        const url = checkUrl(args["url"]);
        if (id === null || !url) {
          return "error: browser_navigate needs an integer 'tab' and an http(s) 'url'";
        }
        return formatTab(await browser.navigate(id, url));
      }),
    browser_read: (args) =>
      onTab(
        args,
        async (id) => {
          const text =
            (await browser.readText(id)).trim() || "(page has no text)";
          // The two parts are bounded separately: a long page's text is saved to a temp file
          // (its start stays here), while the elements the model must act on are always shown.
          const shown = !isTooLarge(text)
            ? text
            : temp
              ? temp.spill("browser_read", text)
              : truncateInline(text, "there is nowhere to save it");
          const elements = clip(await browser.snapshot(id));
          return `${shown}\n\nInteractive elements (use the ref with browser_click, browser_type, ...):\n${elements || "(none)"}`;
        },
        "",
      ),
    ...waitHandlers(browser, onTab, text),
    browser_click: (args) =>
      onTab(args, (id) => browser.click(id, ref(args)), "clicked", true),
    browser_hover: (args) =>
      onTab(args, (id) => browser.hover(id, ref(args)), "hovered"),
    browser_drag: (args) =>
      onTab(
        args,
        (id) => browser.drag(id, ref(args, "from_ref"), ref(args, "to_ref")),
        "dragged",
        true,
      ),
    browser_type: (args) =>
      onTab(
        args,
        (id) =>
          browser.typeText(id, str(args, "ref"), str(args, "text") ?? "", {
            replace: args["replace"] === true,
            key: str(args, "key"),
          }),
        "typed",
        true,
      ),
    browser_upload: (args) =>
      onTab(
        args,
        (id) => upload(browser, id, ref(args), args["paths"], cwd),
        "",
      ),
    browser_select: (args) =>
      onTab(args, (id) => select(browser, id, ref(args), args), "", true),
    browser_scroll: (args) =>
      onTab(args, (id) => scroll(browser, id, args), ""),
    browser_screenshot: (args) =>
      onTab(args, (id) => screenshot(browser, images, id, args), ""),
    browser_handle_dialog: (args) =>
      onTab(
        args,
        (id) =>
          browser.handleDialog(
            id,
            args["accept"] !== false,
            str(args, "prompt_text"),
          ),
        "dialog handled",
      ),
    browser_run_code: (args) =>
      onTab(args, (id) => browser.runCode(id, ref(args, "code")), "done"),
    browser_close_tab: (args) =>
      onTab(
        args,
        async (id) => {
          await browser.closeTab(id);
          return `tab ${id} closed`;
        },
        "",
      ),
  };
}
