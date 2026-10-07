import { getPort } from "./config.ts";

const PAIR_RETRY_MS = 1500;

/**
 * The sidebar: a control strip (hand the current tab to Vise, see and release
 * the tabs Vise has) above the Vise web UI embedded from the local server.
 */

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const frame = el<HTMLIFrameElement>("app");
const offline = el("offline");
let loaded = false;
/** Whether the Vise page has answered with a token this time (a stored one may be stale). */
let paired = false;

/** Show the UI when the server answers, otherwise the "not running" notice. */
async function load(): Promise<void> {
  const origin = `http://127.0.0.1:${await getPort()}`;
  try {
    await fetch(origin, { mode: "no-cors" });
  } catch {
    loaded = false;
    frame.hidden = true;
    offline.hidden = false;
    setTimeout(() => void load(), 3000);
    return;
  }
  offline.hidden = true;
  frame.hidden = false;
  if (!loaded) {
    frame.src = `${origin}/?ui=sidebar`;
    loaded = true;
    void pair(origin);
  }
}

/** Ask the embedded Vise page for the pairing token until the extension has it. */
async function pair(origin: string): Promise<void> {
  if (paired) return;
  frame.contentWindow?.postMessage({ type: "vise-hello" }, origin);
  setTimeout(() => void pair(origin), PAIR_RETRY_MS);
}

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as { type?: string; token?: unknown } | null;
  if (data?.type !== "vise-token" || typeof data.token !== "string") return;
  if (event.source !== frame.contentWindow) return;
  paired = true;
  void browser.storage.local.set({ token: data.token });
});

interface Status {
  connected: boolean;
  tabs: { id: number; title: string; url: string }[];
}

async function refresh(): Promise<void> {
  const status = (await browser.runtime.sendMessage({
    type: "status",
  })) as Status;
  el("status").textContent = status.connected
    ? `connected, ${status.tabs.length} tab(s)`
    : "not connected to Vise";
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

el("give").addEventListener("click", () => {
  const button = el<HTMLButtonElement>("give");
  button.disabled = true;
  browser.runtime
    .sendMessage({ type: "give" })
    .then((result: GiveResult | undefined) => {
      if (!result) throw new Error("the extension did not answer");
      if (result.ok) {
        notify(
          true,
          result.already
            ? `Vise already has "${result.tab}".`
            : `Vise can now use "${result.tab}".`,
        );
      } else {
        notify(false, result.error ?? "Could not give this tab to Vise.");
      }
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
el("retry").addEventListener("click", () => void load());
browser.runtime.onMessage.addListener((message: { type: string }) => {
  if (message.type === "changed") void refresh();
});

void load();
void refresh();
setInterval(() => void refresh(), 3000);
