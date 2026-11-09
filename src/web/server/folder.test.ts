import { afterEach, expect, test } from "bun:test";
import { Channel } from "../../protocol/channel.ts";
import type { ClientMessage, ServerEvent, Session } from "../../protocol/protocol.ts";
import { ok, type Ok, type Result } from "../../core/messages.ts";
import { startWebServer, type WebServer } from "./server.ts";

const TOKEN = "folder-token";
const assets = { html: "<p>page</p>", script: "", style: "" };
let running: WebServer | undefined;

afterEach(() => {
  running?.stop();
  running = undefined;
});

// A session in a folder. It announces the folder, records what it is sent, and ends when its input is ended.
function sessionIn(path: string, sent: ClientMessage[] = []): Session {
  const events = new Channel<ServerEvent>();
  events.push({ kind: "folder", path });
  return {
    send: (message) => {
      sent.push(message);
      if (message.kind !== "inputEnded") return;
      events.push({ kind: "ended" });
      events.end();
    },
    events: () => events,
  };
}

// Waits for a condition to hold, for a short time.
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt++) {
    await Bun.sleep(10);
  }
  expect(condition()).toBe(true);
}

// Starts the server and a page connected to it. Returns what the page received, and the socket.
async function connectPage(changeFolder: (path: string) => Promise<Result<Session>>) {
  const started = startWebServer({
    session: sessionIn("A"),
    assets,
    token: TOKEN,
    changeFolder,
  }) as Ok<WebServer>;
  running = started.value;
  const base = new URL(running.url).origin;
  const received: ServerEvent[] = [];
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws?t=${TOKEN}`, {
    headers: { origin: base },
  } as unknown as string[]);
  socket.onmessage = (event) => received.push(JSON.parse(String(event.data)) as ServerEvent);
  await waitFor(() => received.some((event) => event.kind === "folder" && event.path === "A"));
  return { received, socket };
}

test("a folder change ends the session, starts one in the new folder, and keeps the page connected", async () => {
  const { received, socket } = await connectPage(async (path) => ok(sessionIn(path)));
  socket.send(JSON.stringify({ kind: "folderChange", path: "B" }));
  await waitFor(() => received.some((event) => event.kind === "folder" && event.path === "B"));
  // The old session's ending is not shown, the transcript starts again, and the socket stays open.
  expect(received.some((event) => event.kind === "ended")).toBe(false);
  const reset = received.findIndex((event) => event.kind === "history");
  expect(reset).toBeGreaterThan(received.findIndex((event) => event.kind === "folder" && event.path === "A"));
  expect(received.findIndex((event) => event.kind === "folder" && event.path === "B")).toBeGreaterThan(reset);
  expect(socket.readyState).toBe(WebSocket.OPEN);
  socket.close();
});

test("a line sent while the new folder is starting gets a notice, and a second folder change is refused", async () => {
  let release: (session: Result<Session>) => void = () => undefined;
  const requests: string[] = [];
  const newSent: ClientMessage[] = [];
  const { received, socket } = await connectPage(
    (path) =>
      new Promise<Result<Session>>((resolve) => {
        requests.push(path);
        release = resolve;
      }),
  );
  socket.send(JSON.stringify({ kind: "folderChange", path: "B" }));
  await waitFor(() => requests.length === 1);
  // While the new folder starts, a line and another folder change are refused with a notice, not dropped.
  socket.send(JSON.stringify({ kind: "line", text: "hello" }));
  socket.send(JSON.stringify({ kind: "folderChange", path: "C" }));
  await waitFor(() => received.filter((event) => event.kind === "notice").length === 2);
  expect(requests).toEqual(["B"]);
  // Once the folder is ready, input reaches the new session again.
  release({ ok: true, value: sessionIn("B", newSent) });
  await waitFor(() => received.some((event) => event.kind === "folder" && event.path === "B"));
  socket.send(JSON.stringify({ kind: "line", text: "after" }));
  await waitFor(() => newSent.some((message) => message.kind === "line" && message.text === "after"));
  expect(newSent).toEqual([{ kind: "line", text: "after" }]);
  socket.close();
});
