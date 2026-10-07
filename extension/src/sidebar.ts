import { getPort } from "./config.ts";

/**
 * The sidebar: a control strip (hand the current tab to Vise, see and release
 * the tabs Vise has) above the Vise web UI embedded from the local server.
 */

const el = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const frame = el<HTMLIFrameElement>("app");
const offline = el("offline");
let loaded = false;

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
  }
}

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

el("give").addEventListener("click", () => {
  void browser.runtime.sendMessage({ type: "give" }).then(refresh);
});
el("retry").addEventListener("click", () => void load());
browser.runtime.onMessage.addListener((message: { type: string }) => {
  if (message.type === "changed") void refresh();
});

void load();
void refresh();
setInterval(() => void refresh(), 3000);
