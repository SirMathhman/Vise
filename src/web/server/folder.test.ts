import { afterEach, expect, test } from "bun:test";
import { Channel } from "../../protocol/channel.ts";
import type { ServerEvent, Session } from "../../protocol/protocol.ts";
import { ok, type Ok } from "../../core/messages.ts";
import { startWebServer, type WebServer } from "./server.ts";

const TOKEN = "folder-token";
const assets = { html: "<p>page</p>", script: "", style: "" };
let running: WebServer | undefined;

afterEach(() => {
  running?.stop();
  running = undefined;
});

// A session in a folder. It announces the folder, and it ends when its input is ended.
function sessionIn(path: string): Session {
  const events = new Channel<ServerEvent>();
  events.push({ kind: "folder", path });
  return {
    send: (message) => {
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

test("a folder change ends the session, starts one in the new folder, and keeps the page connected", async () => {
  const started = startWebServer({
    session: sessionIn("A"),
    assets,
    token: TOKEN,
    changeFolder: async (path) => ok(sessionIn(path)),
  }) as Ok<WebServer>;
  running = started.value;
  const base = new URL(running.url).origin;
  const received: ServerEvent[] = [];
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws?t=${TOKEN}`, {
    headers: { origin: base },
  } as unknown as string[]);
  socket.onmessage = (event) => received.push(JSON.parse(String(event.data)) as ServerEvent);
  await waitFor(() => received.some((event) => event.kind === "folder" && event.path === "A"));
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
