import { BUILD, findServerPort } from "./config.ts";

const PAIR_RETRY_MS = 1500;

/**
 * The sidebar: a status widget that always says whether Vise is connected and
 * whether it can see the tab being looked at, a control strip (hand the current
 * tab to Vise, see and release the tabs Vise has), and the Vise web UI embedded
 * from the local server.
 */

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const frame = el<HTMLIFrameElement>("app");
const offline = el("offline");
let loaded = false;
let serverOrigin = "";
/** Whether the last attempt to reach the Vise server worked. */
let serverUp = false;
/** Whether the Vise page has answered with a token this time (a stored one may be stale). */
let paired = false;
/** The browser window this sidebar belongs to: "the current tab" means this window's. */
let windowId: number | undefined;

/** Show the UI when the server answers, otherwise the "not running" notice. */
async function load(): Promise<void> {
  serverOrigin = `http://127.0.0.1:${await findServerPort()}`;
  try {
    await fetch(serverOrigin, { mode: "no-cors" });
    serverUp = true;
  } catch {
    serverUp = false;
    loaded = false;
    frame.hidden = true;
    offline.hidden = false;
    setTimeout(() => void load(), 3000);
    return;
  }
  offline.hidden = true;
  frame.hidden = false;
  if (!loaded) {
    frame.src = `${serverOrigin}/?ui=sidebar`;
    loaded = true;
    void pair();
  }
}

/** Ask the embedded Vise page for the pairing token until the extension has it. */
function pair(): void {
  if (paired) return;
  frame.contentWindow?.postMessage({ type: "vise-hello" }, serverOrigin);
  setTimeout(pair, PAIR_RETRY_MS);
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type?: string; token?: unknown } | null;
  if (data?.type !== "vise-token" || typeof data.token !== "string") return;
  if (event.source !== frame.contentWindow) return;
  paired = true;
  void browser.storage.local.set({ token: data.token });
});

interface Status {
  /** The build of the background page; an older one answers differently or not at all. */
  build?: string;
  link?: "no-token" | "connecting" | "connected" | "closed";
  linkNote?: string;
  tabs: { id: number; title: string; url: string }[];
  current?: {
    title: string;
    url: string;
    owned: boolean;
    usable: boolean;
  } | null;
}

/** The one-line verdict and (when something is wrong) what to do about it. */
function verdict(status: Status): {
  level: "ok" | "warn" | "bad";
  text: string;
  help: string;
} {
  if (status.build !== BUILD) {
    return {
      level: "bad",
      text: "✕ The Vise extension is out of date",
      help: "This sidebar was updated but the extension's background page is still an older build, so they disagree. Open about:debugging → This Firefox → click Reload next to Vise, then reopen this sidebar.",
    };
  }
  if (status.link === "no-token") {
    return {
      level: "bad",
      text: "✕ Not connected to Vise",
      help: "Not paired yet: waiting for the Vise page below to hand over its pairing token. If this stays, restart `bun run web` (the page may be out of date), then press Re-pair.",
    };
  }
  if (status.link === "connecting") {
    return {
      level: "bad",
      text: "✕ Not connected to Vise",
      help: "Connecting…",
    };
  }
  if (status.link === "closed") {
    return {
      level: "bad",
      text: "✕ Not connected to Vise",
      help: `${status.linkNote} If you restarted Vise or deleted ~/.vise/ext-token, press Re-pair.`,
    };
  }
  const current = status.current;
  if (!current) {
    return {
      level: "warn",
      text: "○ Connected to Vise",
      help: "There is no active tab to share.",
    };
  }
  if (current.owned) {
    return {
      level: "ok",
      text: "● Connected to this tab",
      help: "Vise can see and control it.",
    };
  }
  if (!current.usable) {
    return {
      level: "warn",
      text: "○ Not connected to this tab",
      help: "Vise can only use web pages (http or https), not this kind of page.",
    };
  }
  return {
    level: "warn",
    text: "○ Not connected to this tab",
    help: "Vise cannot see it yet. Press “Give Vise this tab”.",
  };
}

/** One line of explicit checks, so it is plain which link in the chain is broken. */
function checks(status: Status): string {
  const mark = (ok: boolean): string => (ok ? "✓" : "✕");
  const current = status.build === BUILD;
  return [
    `Server ${mark(serverUp)}`,
    `Extension ${mark(current)}${current ? "" : " (old build)"}`,
    `Pairing ${current ? mark(status.link !== "no-token") : "?"}`,
    `Link ${current ? mark(status.link === "connected") : "?"}`,
    `Shared tabs ${status.tabs.length}`,
  ].join(" · ");
}

function render(status: Status): void {
  const { level, text, help } = verdict(status);
  el("checks").textContent = checks(status);
  const badge = el("badge");
  badge.className = level;
  el("badge-text").textContent = text;
  el("badge-help").textContent = help;
  el("current").textContent = status.current
    ? `Current tab: ${status.current.title || status.current.url}`
    : "";
  // Re-pairing only helps while the link is down.
  el("repair").hidden = status.link === "connected";
  const list = el("owned");
  list.textContent = "";
  for (const tab of status.tabs) {
    const item = document.createElement("li");
    const title = document.createElement("span");
    title.textContent = tab.title || tab.url;
    title.title = tab.url;
    const drop = document.createElement("button");
    drop.textContent = "release";
    drop.addEventListener("click", () => {
      void browser.runtime
        .sendMessage({ type: "release", tab: tab.id })
        .then(refresh);
    });
    item.append(title, drop);
    list.append(item);
  }
}

async function refresh(): Promise<void> {
  try {
    const status = (await browser.runtime.sendMessage({
      type: "status",
      windowId,
    })) as Status;
    render(status);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    el("badge").className = "bad";
    el("badge-text").textContent = "✕ The Vise extension is not responding";
    el("badge-help").textContent =
      `Reload it from about:debugging (${reason}).`;
    el("checks").textContent =
      `Server ${serverUp ? "✓" : "✕"} · Extension ✕ (not responding)`;
  }
}

/** What the background answers to "give": success, or an error to show. */
interface GiveResult {
  ok: boolean;
  tab?: string;
  already?: boolean;
  error?: string;
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

/** Show a success (✓) or error (✕) message under the button for a few seconds. */
function notify(ok: boolean, text: string): void {
  const notice = el("notice");
  notice.className = ok ? "ok" : "error";
  notice.textContent = `${ok ? "✓" : "✕"} ${text}`;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (notice.hidden = true), 6000);
}

/** Describe a "give" answer; an old background page may answer without the tab's name. */
function describeGive(result: GiveResult): { ok: boolean; text: string } {
  if (!result.ok) {
    return {
      ok: false,
      text: result.error ?? "Could not give this tab to Vise.",
    };
  }
  const name = result.tab ? `"${result.tab}"` : "this tab";
  return {
    ok: true,
    text: result.already
      ? `Vise already has ${name}.`
      : `Vise can now use ${name}.`,
  };
}

el("give").addEventListener("click", () => {
  const button = el<HTMLButtonElement>("give");
  button.disabled = true;
  browser.runtime
    .sendMessage({ type: "give", windowId })
    .then((result: GiveResult | undefined) => {
      if (!result) throw new Error("the extension did not answer");
      const { ok, text } = describeGive(result);
      notify(ok, text);
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      notify(false, `Could not give this tab to Vise (${reason}).`);
    })
    .finally(() => {
      button.disabled = false;
      void refresh();
    });
});

el("repair").addEventListener("click", () => {
  paired = false;
  void browser.runtime.sendMessage({ type: "repair" }).then(() => {
    pair();
    void refresh();
  });
});
el("retry").addEventListener("click", () => void load());
browser.runtime.onMessage.addListener((message: { type: string }) => {
  if (message.type === "changed") void refresh();
});

void browser.windows.getCurrent().then((window) => {
  windowId = window.id;
  void refresh();
});
void load();
setInterval(() => void refresh(), 3000);
