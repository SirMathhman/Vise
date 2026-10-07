import type { BrowserBackend, TabInfo } from "../browser/types.ts";
import { errStr } from "./files.ts";

/** Page text returned to the model is capped so one tool result cannot fill the context. */
const MAX_TEXT_CHARS = 20_000;

type Handler = (args: Record<string, unknown>) => Promise<string>;

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

/** Run a browser action, turning any failure into the tool's `error:` string. */
async function guarded(action: () => Promise<string>): Promise<string> {
  try {
    return await action();
  } catch (err) {
    return `error: ${errStr(err)}`;
  }
}

function str(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Appended to an action's result when it left a JavaScript dialog open. */
function dialogNote(browser: BrowserBackend, id: number): string {
  const dialog = browser.pendingDialog(id);
  return dialog
    ? `\n[a ${dialog.type} dialog is open: "${dialog.message}" - call browser_handle_dialog]`
    : "";
}

/**
 * Edge handlers for the browser tools, bound to one `BrowserBackend`. They
 * depend only on the backend-neutral interface, so swapping in another
 * browser engine does not change them.
 */
export function makeBrowserHandlers(
  browser: BrowserBackend,
): Record<string, Handler> {
  /** Validate `tab`, run `action`, and report `done` plus any dialog it opened. */
  const onTab = (
    args: Record<string, unknown>,
    action: (id: number) => Promise<string | void>,
    done: string,
  ): Promise<string> =>
    guarded(async () => {
      const id = tabId(args);
      if (id === null) return "error: an integer 'tab' is required";
      const out = (await action(id)) ?? done;
      return `${out}${dialogNote(browser, id)}`;
    });
  const ref = (args: Record<string, unknown>, name = "ref"): string => {
    const value = str(args, name);
    if (!value) throw new Error(`'${name}' is required (e.g. "e3")`);
    return value;
  };
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
          const clipped =
            text.length <= MAX_TEXT_CHARS
              ? text
              : `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated: ${text.length} characters total]`;
          const elements = await browser.snapshot(id);
          return `${clipped}\n\nInteractive elements (use the ref with browser_click, browser_type, ...):\n${elements || "(none)"}`;
        },
        "",
      ),
    browser_click: (args) =>
      onTab(args, (id) => browser.click(id, ref(args)), "clicked"),
    browser_hover: (args) =>
      onTab(args, (id) => browser.hover(id, ref(args)), "hovered"),
    browser_drag: (args) =>
      onTab(
        args,
        (id) => browser.drag(id, ref(args, "from_ref"), ref(args, "to_ref")),
        "dragged",
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
      ),
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
  };
}
