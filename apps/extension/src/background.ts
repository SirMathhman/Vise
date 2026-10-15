import { BUILD, findServerPort, getToken } from "./config.ts";
import { ops } from "./ops.ts";
import {
  getTabLimit,
  isOwned,
  onOwnedChanged,
  onPromoted,
  ownedIds,
  release,
  setTabLimit,
  tryGrant,
  pendingCount,
} from "./tabs.ts";

/**
 * The extension's background page: holds the WebSocket to the Vise server
 * (`/ext`), runs the operations the server asks for on the tabs Vise may use,
 * and answers the sidebar's status widget and control strip.
 */

/** Where the link to the Vise server stands, for the sidebar to explain. */
type Link = "no-token" | "connecting" | "connected" | "closed";

let socket: WebSocket | null = null;
let retry = 0;
let link: Link = "connecting";
/** Why the link is down, in words the user can act on. */
let linkNote = "";

function send(message: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function handle(raw: string): Promise<void> {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  // The server pushes config on connect; store it and do not respond.
  if (typeof msg["config"] === "object" && msg["config"] !== null) {
    const config = msg["config"] as Record<string, unknown>;
    const limit = config["tabLimit"];
    if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1) {
      setTabLimit(limit);
      void browser.storage.local.set({ tabLimit: limit });
    }
    return;
  }
  const request = msg as { id: number; op: string; params?: Record<string, unknown> };
  const op = ops[request.op];
  try {
    if (!op) throw new Error(`unknown operation ${request.op}`);
    const result = await op(request.params ?? {});
    send({ id: request.id, ok: true, result: result ?? null });
  } catch (error) {
    send({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function setLink(next: Link, note = ""): void {
  link = next;
  linkNote = note;
  notifySidebar();
}

async function connect(): Promise<void> {
  // Not paired yet: the sidebar hands over the token the first time it loads.
  const token = await getToken();
  if (!token) {
    setLink("no-token");
    setTimeout(() => void connect(), 2000);
    return;
  }
  setLink("connecting");
  const port = await findServerPort();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext?token=${encodeURIComponent(token)}`);
  socket = ws;
  let opened = false;
  ws.addEventListener("open", () => {
    opened = true;
    retry = 0;
    setLink("connected");
    send({ event: "tabs" });
  });
  ws.addEventListener("message", (event) => void handle(String(event.data)));
  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    setLink(
      "closed",
      opened
        ? "The Vise server closed the connection."
        : `Could not connect to the Vise server (found none from port ${port} up): it is not running, or it rejected the pairing token.`,
    );
    // Keep trying: the server may simply not be running yet.
    setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** retry++));
  });
}

/** Tell the sidebar that something it shows changed. */
function notifySidebar(): void {
  void browser.runtime.sendMessage({ type: "changed" }).catch(() => undefined);
}

/** Tell the server and the sidebar that the tabs Vise may use changed. */
function announce(): void {
  send({ event: "tabs" });
  notifySidebar();
}

onOwnedChanged(announce);
// When a queued tab is promoted to owned, tell the server (same as a user-shared tab).
onPromoted((tab) => {
  send({
    event: "shared",
    tab: { id: tab.id, title: tab.title, url: tab.url },
  });
  notifySidebar();
});
// The sidebar shows the tab being looked at, so follow tab switches and loads.
browser.tabs.onActivated.addListener(notifySidebar);
browser.tabs.onUpdated.addListener((_id, _change, tab) => {
  if (tab.active) notifySidebar();
});

/** The tab the user is looking at in a window (the sidebar's own window when given). */
async function activeTab(windowId?: number): Promise<browser.tabs.Tab | null> {
  const [tab] = await browser.tabs.query(
    windowId === undefined ? { active: true, lastFocusedWindow: true } : { active: true, windowId },
  );
  return tab ?? null;
}

/** Vise only drives web pages; browser-internal pages cannot be scripted. */
const isWebPage = (url: string | undefined): boolean => /^https?:/.test(url ?? "");

async function status(windowId?: number): Promise<unknown> {
  const tabs = [];
  for (const id of ownedIds()) {
    try {
      const tab = await browser.tabs.get(id);
      tabs.push({ id, title: tab.title ?? "", url: tab.url ?? "" });
    } catch {
      release(id);
    }
  }
  const current = await activeTab(windowId);
  return {
    build: BUILD,
    link,
    linkNote,
    tabs,
    tabLimit: getTabLimit(),
    pending: pendingCount(),
    current:
      current?.id === undefined
        ? null
        : {
            title: current.title ?? "",
            url: current.url ?? "",
            owned: isOwned(current.id),
            usable: isWebPage(current.url),
          },
  };
}

/** The answer to "give Vise this tab": exactly one of success or an error message. */
interface GiveResult {
  ok: boolean;
  /** The tab's title or address, when there is one. */
  tab?: string;
  /** The tab was already Vise's. */
  already?: boolean;
  error?: string;
}

/** Hand the window's active tab over to Vise. */
async function give(windowId?: number): Promise<GiveResult> {
  const tab = await activeTab(windowId);
  if (tab?.id === undefined) {
    return { ok: false, error: "Could not find the active tab." };
  }
  const name = tab.title || tab.url || "this tab";
  if (!isWebPage(tab.url)) {
    return {
      ok: false,
      error: `Vise can only use web pages (http or https), and "${name}" is not one.`,
    };
  }
  const already = isOwned(tab.id);
  if (!already) {
    const result = tryGrant(tab.id);
    if (!result.ok) {
      return {
        ok: false,
        error: `Tab limit reached. Release a tab first.`,
      };
    }
    // The agent is told, so it need not discover the tab by listing tabs.
    send({
      event: "shared",
      tab: { id: tab.id, title: tab.title ?? "", url: tab.url ?? "" },
    });
  }
  return { ok: true, tab: name, already };
}

/** The user takes a tab back from Vise: release it and tell the agent. */
async function giveBack(tabId: number): Promise<void> {
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  release(tabId);
  send({
    event: "released",
    tab: { id: tabId, title: tab?.title ?? "", url: tab?.url ?? "" },
  });
}

/** Forget the stored pairing token and reconnect (the sidebar then pairs again). */
async function repair(): Promise<void> {
  await browser.storage.local.remove("token");
  socket?.close();
}

/** What the sidebar asks for. */
browser.runtime.onMessage.addListener(
  (message: { type: string; tab?: number; windowId?: number }) => {
    if (message.type === "status") return status(message.windowId);
    if (message.type === "give") return give(message.windowId);
    if (message.type === "repair") return repair();
    if (message.type === "release" && typeof message.tab === "number") {
      return giveBack(message.tab);
    }
    return undefined;
  },
);

// The toolbar button opens and closes the sidebar.
browser.browserAction.onClicked.addListener(() => void browser.sidebarAction.toggle());

// Test builds only (`define`): open the sidebar page in a tab so the pairing flow can run without a sidebar.
declare const __VISE_TEST_SIDEBAR_TAB__: boolean | undefined;
if (typeof __VISE_TEST_SIDEBAR_TAB__ !== "undefined" && __VISE_TEST_SIDEBAR_TAB__) {
  void browser.tabs.create({
    url: browser.runtime.getURL("sidebar.html"),
    active: false,
  });
}

void connect();
