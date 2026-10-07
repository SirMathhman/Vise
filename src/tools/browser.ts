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

/**
 * Edge handlers for the browser tools, bound to one `BrowserBackend`. They
 * depend only on the backend-neutral interface, so swapping in another
 * browser engine does not change them.
 */
export function makeBrowserHandlers(
  browser: BrowserBackend,
): Record<string, Handler> {
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
          ? "no tabs open"
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
      guarded(async () => {
        const id = tabId(args);
        if (id === null) return "error: browser_read needs an integer 'tab'";
        const text = (await browser.readText(id)).trim();
        if (text.length <= MAX_TEXT_CHARS) return text || "(page has no text)";
        return `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated: ${text.length} characters total]`;
      }),
  };
}
