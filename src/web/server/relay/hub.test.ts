import { expect, test } from "bun:test";
import type { ClientMessage, ServerEvent } from "../../../protocol/protocol.ts";
import { createHub, type Viewer } from "./hub.ts";

// A viewer that records what it was sent and how it was closed.
interface RecordingViewer extends Viewer {
  sent: unknown[];
  closed: number[];
}

function fakeViewer(): RecordingViewer {
  const sent: unknown[] = [];
  const closed: number[] = [];
  return {
    sent,
    closed,
    send(text) {
      sent.push(JSON.parse(text));
    },
    close(code) {
      closed.push(code);
    },
  };
}

test("a viewer that connects late gets the whole log; a second viewer takes over", () => {
  const forwarded: ClientMessage[] = [];
  const hub = createHub((message) => forwarded.push(message));
  const notice: ServerEvent = { kind: "notice", text: "hi" };
  hub.publish(notice);

  const first = fakeViewer();
  hub.attach(first);
  expect(first.sent).toEqual([notice]);

  const second = fakeViewer();
  hub.attach(second);
  expect(first.closed).toEqual([4001]);
  expect(second.sent).toEqual([notice]);

  hub.receive(first, '{"kind":"line","text":"stale"}');
  hub.receive(second, '{"kind":"line","text":"fresh"}');
  hub.receive(second, "garbage");
  expect(forwarded).toEqual([{ kind: "line", text: "fresh" }]);
  expect(second.sent.at(-1)).toEqual({ kind: "error", message: "the message is not JSON" });
});

test("once the session has ended, the viewer is closed and a later viewer is closed at once", () => {
  const hub = createHub(() => {});
  const viewer = fakeViewer();
  hub.attach(viewer);
  hub.publish({ kind: "ended" });
  expect(viewer.closed).toEqual([1000]);

  const later = fakeViewer();
  hub.attach(later);
  expect(later.sent).toEqual([{ kind: "ended" }]);
  expect(later.closed).toEqual([1000]);
});

test("an answer to a page's request goes to the attached page and is not replayed to a page that reloads", () => {
  const hub = createHub(() => {});
  const viewer = fakeViewer();
  hub.attach(viewer);
  const answer: ServerEvent = { kind: "file", path: "a.txt", text: "hi" };
  hub.publish(answer);
  expect(viewer.sent).toEqual([answer]);

  const reloaded = fakeViewer();
  hub.attach(reloaded);
  expect(reloaded.sent).toEqual([]);
});
