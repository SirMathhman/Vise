import { afterEach, expect, test } from "bun:test";
import { Channel } from "../../protocol/channel.ts";
import type {
  ClientMessage,
  ServerEvent,
  Session,
} from "../../protocol/protocol.ts";
import type { Ok } from "../../core/messages.ts";
import { startWebServer, type WebServer } from "./server.ts";

const TOKEN = "test-token";
const assets = { html: "<p>page</p>", script: "", style: "" };
let running: WebServer | undefined;

afterEach(() => {
  running?.stop();
  running = undefined;
});

// A session whose events the test pushes, and whose received messages the test reads.
interface FakeSession {
  session: Session;
  events: Channel<ServerEvent>;
  sent: ClientMessage[];
}

function fakeSession(): FakeSession {
  const events = new Channel<ServerEvent>();
  const sent: ClientMessage[] = [];
  return {
    events,
    sent,
    session: {
      send: (message) => sent.push(message),
      events: () => events,
    },
  };
}

function start(session: Session): WebServer {
  const started = startWebServer({ session, assets, token: TOKEN }) as Ok<WebServer>;
  expect(started.ok).toBe(true);
  running = started.value;
  return running;
}

test("a connection with the wrong token or origin is refused, and the page is served", async () => {
  const server = start(fakeSession().session);
  const base = new URL(server.url).origin;
  const wrongToken = await fetch(`${base}/ws?t=nope`, {
    headers: { origin: base },
  });
  expect(wrongToken.status).toBe(403);
  const wrongOrigin = await fetch(`${base}/ws?t=${TOKEN}`, {
    headers: { origin: "http://evil.example" },
  });
  expect(wrongOrigin.status).toBe(403);
  const page = await fetch(`${base}/`);
  expect(await page.text()).toBe("<p>page</p>");
});

test("a socket replays the session, forwards its lines, and is closed when the session ends", async () => {
  const fake = fakeSession();
  fake.events.push({ kind: "notice", text: "hello" });
  const server = start(fake.session);
  const base = new URL(server.url).origin;
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws?t=${TOKEN}`, {
    headers: { origin: base },
  } as unknown as string[]);
  const received = new Promise<unknown>((resolve) => {
    socket.addEventListener(
      "message",
      (event) => resolve(JSON.parse(String(event.data))),
      { once: true },
    );
  });
  expect(await received).toEqual({ kind: "notice", text: "hello" });

  socket.send(JSON.stringify({ kind: "line", text: "hi" }));
  while (fake.sent.length === 0) await Bun.sleep(5);
  expect(fake.sent).toEqual([{ kind: "line", text: "hi" }]);

  const closed = new Promise<CloseEvent>((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
  fake.events.push({ kind: "ended" });
  expect((await closed).code).toBe(1000);
  await server.ended;
});
