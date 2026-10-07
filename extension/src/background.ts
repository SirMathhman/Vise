import { getPort, getToken } from "./config.ts";
import { ops } from "./ops.ts";
import { grant, onOwnedChanged, ownedIds, release } from "./tabs.ts";

/**
 * The extension's background page: holds the WebSocket to the Vise server
 * (`/ext`), runs the operations the server asks for on the tabs Vise may use,
 * and answers the sidebar's control strip.
 */

let socket: WebSocket | null = null;
let retry = 0;

function send(message: Record<string, unknown>): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

async function handle(raw: string): Promise<void> {
  let request: { id: number; op: string; params?: Record<string, unknown> };
  try {
    request = JSON.parse(raw);
  } catch {
    return;
  }
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

async function connect(): Promise<void> {
  // Not paired yet: the sidebar hands over the token the first time it loads.
  const token = await getToken();
  if (!token) {
    setTimeout(() => void connect(), 2000);
    return;
  }
  const port = await getPort();
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ext?token=${encodeURIComponent(token)}`,
  );
  socket = ws;
  ws.addEventListener("open", () => {
    retry = 0;
    announce();
  });
  ws.addEventListener("message", (event) => void handle(String(event.data)));
  ws.addEventListener("close", () => {
    if (socket === ws) socket = null;
    announce();
    // Keep trying: the server may simply not be running yet.
    setTimeout(() => void connect(), Math.min(30_000, 1000 * 2 ** retry++));
  });
}

/** Tell the server and the sidebar that the connection or the tab set changed. */
function announce(): void {
  send({ event: "tabs" });
  void browser.runtime.sendMessage({ type: "changed" }).catch(() => undefined);
}

onOwnedChanged(announce);

async function status(): Promise<unknown> {
  const tabs = [];
  for (const id of ownedIds()) {
    try {
      const tab = await browser.tabs.get(id);
      tabs.push({ id, title: tab.title ?? "", url: tab.url ?? "" });
    } catch {
      release(id);
    }
  }
  return { connected: socket?.readyState === WebSocket.OPEN, tabs };
}

/** Hand the window's active tab over to Vise. */
async function give(): Promise<unknown> {
  const [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (tab?.id === undefined) return { ok: false, error: "no active tab" };
  grant(tab.id);
  return { ok: true };
}

/** What the sidebar's control strip asks for. */
browser.runtime.onMessage.addListener(
  (message: { type: string; tab?: number }) => {
    if (message.type === "status") return status();
    if (message.type === "give") return give();
    if (message.type === "release" && typeof message.tab === "number") {
      release(message.tab);
    }
    return undefined;
  },
);

// The toolbar button opens and closes the sidebar.
browser.browserAction.onClicked.addListener(
  () => void browser.sidebarAction.toggle(),
);

void connect();
