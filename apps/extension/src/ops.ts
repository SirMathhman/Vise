import {
  probeScript,
  REF_PATTERN,
  focusScript,
  fileInputProblem,
  fileInputScript,
  pageActionScript,
  type PageAction,
  SNAPSHOT_SCRIPT,
} from "../../../packages/backend/src/browser/page-scripts.ts";
import {
  clickScript,
  dragScript,
  hoverScript,
  insertTextScript,
  keyScript,
  PRESSABLE_KEYS,
  type ActionResult,
  type UploadFile,
  uploadScript,
} from "./page-actions.ts";
import { ownedIds, release, requireOwned, tryGrant } from "./tabs.ts";
import type { TabInfo } from "../../../packages/backend/src/browser/types.ts";

/** The operations the Vise server asks for (see `src/web/ext/ext-hub.ts` and `src/browser/extension.ts`). */

const LOAD_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Only web pages: the agent never opens browser-internal or `file:` pages. */
function checkUrl(raw: unknown): string {
  const url = String(raw ?? "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (url !== "about:blank" && !["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("only http(s) URLs may be opened");
  }
  return url;
}

function checkRef(ref: unknown): string {
  const text = String(ref ?? "");
  if (!REF_PATTERN.test(text)) throw new Error(`invalid ref: ${text}`);
  return text;
}

async function info(tabId: number): Promise<TabInfo> {
  const tab = await browser.tabs.get(tabId);
  return { id: tabId, url: tab.url ?? "", title: tab.title ?? "" };
}

/** Resolves once the tab has finished loading, or after `timeoutMs` (slow pages still return). */
function waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, change: { status?: string }): void => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(done, timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
    void browser.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") done();
    });
  });
}

/** After an action: give a page it started navigating a moment to begin, then wait for it. */
async function settle(tabId: number): Promise<void> {
  await sleep(200);
  const tab = await browser.tabs.get(tabId);
  if (tab.status === "loading") await waitForLoad(tabId, SETTLE_TIMEOUT_MS);
}

/** Run a script in the tab's content-script world and return its value. */
async function run<T>(tabId: number, code: string): Promise<T> {
  try {
    const results = (await browser.tabs.executeScript(tabId, { code })) as T[];
    return results[0] as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot script this page (${reason})`, { cause: error });
  }
}

async function act(tabId: number, code: string): Promise<void> {
  const result = await run<ActionResult | undefined>(tabId, code);
  if (!result?.ok) throw new Error(result?.error ?? "the page did not respond");
  await settle(tabId);
}

type Params = Record<string, unknown>;

/** The dialogs the page raised since the last read, which the content script answered itself. */
const DIALOG_NOTES = `(() => {
  const seen = (window.__viseDialogs || []).splice(0);
  return seen.map((d) => d.type + ' "' + d.message + '" -> ' + d.answer).join('; ');
})()`;

export const ops: Record<string, (params: Params) => Promise<unknown>> = {
  async openTab({ url }) {
    const tab = await browser.tabs.create({ url: checkUrl(url), active: true });
    if (tab.id === undefined) throw new Error("the browser did not open a tab");
    const result = tryGrant(tab.id);
    if (!result.ok) {
      await browser.tabs.remove(tab.id);
      throw new Error("tab limit reached, release a tab first");
    }
    await waitForLoad(tab.id, LOAD_TIMEOUT_MS);
    return info(tab.id);
  },

  async listTabs() {
    const out: TabInfo[] = [];
    for (const id of ownedIds()) {
      try {
        out.push(await info(id));
      } catch {
        release(id);
      }
    }
    return out;
  },

  async navigate({ tab, url }) {
    const id = requireOwned(tab);
    await browser.tabs.update(id, { url: checkUrl(url) });
    await waitForLoad(id, LOAD_TIMEOUT_MS);
    return info(id);
  },

  async readText({ tab }) {
    const text = await run<string>(
      requireOwned(tab),
      "document.body ? document.body.innerText : ''",
    );
    return text ?? "";
  },

  async probe({ tab, needle }) {
    return run<unknown>(
      requireOwned(tab),
      probeScript(typeof needle === "string" ? needle : undefined),
    );
  },

  async snapshot({ tab }) {
    const id = requireOwned(tab);
    const outline = await run<string>(id, SNAPSHOT_SCRIPT);
    const dialogs = await run<string>(id, DIALOG_NOTES);
    return dialogs ? `${outline}\n[dialogs answered automatically: ${dialogs}]` : outline;
  },

  async click({ tab, ref }) {
    await act(requireOwned(tab), clickScript(checkRef(ref)));
  },

  async hover({ tab, ref }) {
    await act(requireOwned(tab), hoverScript(checkRef(ref)));
  },

  async uploadFiles({ tab, ref, files }) {
    const id = requireOwned(tab);
    const list = Array.isArray(files) ? (files as UploadFile[]) : [];
    const name = checkRef(ref);
    const status = await run<string>(id, fileInputScript(name));
    const problem = fileInputProblem(status, name, list.length);
    if (problem) throw new Error(problem);
    await act(id, uploadScript(list));
  },

  async drag({ tab, from, to }) {
    await act(requireOwned(tab), dragScript(checkRef(from), checkRef(to)));
  },

  async typeText({ tab, ref, text, replace, key }) {
    const id = requireOwned(tab);
    const press = typeof key === "string" && key !== "" ? keyScript(key) : null;
    if (typeof key === "string" && key !== "" && !press) {
      throw new Error(`unsupported key ${key}; use one of ${PRESSABLE_KEYS.join(", ")}`);
    }
    if (ref !== undefined) {
      const focused = await run<boolean>(id, focusScript(checkRef(ref), replace === true));
      if (!focused) {
        throw new Error(`unknown element ${String(ref)}: call browser_read for fresh refs`);
      }
    }
    if (typeof text === "string" && text !== "") {
      await act(id, insertTextScript(text));
    }
    if (press) await act(id, press);
  },

  async pageAction({ tab, action }) {
    // The script is built here from the named action; script text from the server is never run.
    return run(requireOwned(tab), pageActionScript(action as PageAction));
  },

  async screenshot({ tab }) {
    const id = requireOwned(tab);
    // Only the visible tab of a window can be captured, so bring this one forward first.
    const shown = await browser.tabs.update(id, { active: true });
    await sleep(150);
    const url = await browser.tabs.captureVisibleTab(
      shown.windowId ?? browser.windows.WINDOW_ID_CURRENT,
      {
        format: "png",
      },
    );
    return url.slice(url.indexOf(",") + 1);
  },

  async closeTab({ tab }) {
    const id = requireOwned(tab);
    release(id);
    await browser.tabs.remove(id);
  },

  async runCode({ tab, code }) {
    if (typeof code !== "string") throw new Error("'code' must be a string");
    try {
      return await run(requireOwned(tab), code);
    } catch (error) {
      // run<T> wraps all executeScript errors in "cannot script this page (...)",
      // including the model's own thrown errors. Re-label so the model sees its
      // own bug, not a page problem.
      const reason =
        error instanceof Error
          ? error.message.replace(/^cannot script this page \((.*)\)$/, "$1")
          : String(error);
      throw new Error(`code failed: ${reason}`, { cause: error });
    }
  },
};
