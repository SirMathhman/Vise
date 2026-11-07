import { expect, test } from "bun:test";
import type { ReplyRequest } from "../core/messages.ts";
import type { Conversation } from "../core/compaction.ts";
import type { ResumeStore } from "../core/sessions.ts";
import { err, ok, type Result } from "../core/result.ts";
import type {
  ApprovalRequestEvent,
  ServerEvent,
} from "../protocol/protocol.ts";
import type { SessionPorts } from "./ports.ts";
import { startSession } from "./session.ts";

// The first request asks for an edit; the next one answers with text.
async function* askForEdit({
  messages,
  onToolCall,
}: ReplyRequest): AsyncGenerator<Result<string>> {
  if (messages.at(-1)?.role === "user") {
    onToolCall({
      id: "e1",
      name: "edit_file",
      arguments: '{"path":"f.txt","previous":"a","replacement":"b"}',
    });
    return;
  }
  yield ok("done");
}

// Ports for one session. Each approval answer the tool receives is recorded in `answers`.
function portsFor(answers: boolean[]): SessionPorts {
  return {
    reply: askForEdit,
    contextWindow: async () => ok(1000),
    tools: async (_call, approve) => {
      answers.push(await approve("edit f.txt"));
      return "ran";
    },
    notes: async () => "",
    profile: async () => err(new Error("none")),
    profileTools: async () => ok(undefined),
    profileHooks: async () => ok([]),
    hooks: async () => ok(""),
    disabledTools: [],
    saveDisabledTools: async () => ok(undefined),
    sessions: {
      save: async () => ok(undefined),
      load: async () => err(new Error("none")),
      list: async () => ok([]),
    },
    models: {
      current: () => "m",
      list: async () => ok([]),
      select: async (name: string) => ok(name),
    },
  };
}

// Reads events until one of the given kind, and returns every event read, the last one included.
async function until(
  events: AsyncIterator<ServerEvent>,
  kind: ServerEvent["kind"],
): Promise<ServerEvent[]> {
  const seen: ServerEvent[] = [];
  for (;;) {
    const next = await events.next();
    if (next.done) return seen;
    seen.push(next.value);
    if (next.value.kind === kind) return seen;
  }
}

test("the next line typed answers the approval question", async () => {
  const answers: boolean[] = [];
  const session = startSession(portsFor(answers));
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "go" });
  await until(events, "approvalRequest");
  session.send({ kind: "line", text: "y" });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
  expect(answers).toEqual([true]);
});

test("lines queued before the question are dropped, so they cannot answer it", async () => {
  const answers: boolean[] = [];
  const session = startSession(portsFor(answers));
  const events = session.events()[Symbol.asyncIterator]();
  // Both lines arrive before the question is asked, so the "y" is typed too early to count.
  session.send({ kind: "line", text: "go" });
  session.send({ kind: "line", text: "y" });
  await until(events, "approvalRequest");
  session.send({ kind: "line", text: "n" });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
  expect(answers).toEqual([false]);
});

test("an approval with an id that is not open is ignored", async () => {
  const answers: boolean[] = [];
  const session = startSession(portsFor(answers));
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "go" });
  await until(events, "approvalRequest");
  session.send({ kind: "approval", id: 99, answer: "approve" });
  session.send({ kind: "line", text: "n" });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
  expect(answers).toEqual([false]);
});

test("an approval with the id of the open question answers it", async () => {
  const answers: boolean[] = [];
  const session = startSession(portsFor(answers));
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "go" });
  const asked = await until(events, "approvalRequest");
  const request = asked.at(-1) as ApprovalRequestEvent;
  session.send({ kind: "approval", id: request.id, answer: "approve" });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
  expect(answers).toEqual([true]);
});

test("input that ends with nothing queued runs no tool, so asks no question", async () => {
  const answers: boolean[] = [];
  const session = startSession(portsFor(answers));
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "go" });
  session.send({ kind: "inputEnded" });
  const seen = await until(events, "ended");
  expect(seen.some((event) => event.kind === "approvalRequest")).toBe(false);
  expect(seen.some((event) => event.kind === "toolSkipped")).toBe(true);
  expect(answers).toEqual([]);
  expect(seen.at(-1)).toEqual({ kind: "ended" });
});

test("input that ends after the question is asked refuses it", async () => {
  const answers: boolean[] = [];
  const session = startSession(portsFor(answers));
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "go" });
  session.send({ kind: "line", text: "/context" });
  await until(events, "approvalRequest");
  session.send({ kind: "inputEnded" });
  const seen = await until(events, "ended");
  expect(answers).toEqual([false]);
  expect(seen.at(-1)).toEqual({ kind: "ended" });
});

test("an approval answer is reported as an approvalAnswered event with the question's id", async () => {
  const answers: boolean[] = [];
  const session = startSession(portsFor(answers));
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "go" });
  const asked = await until(events, "approvalRequest");
  const request = asked.at(-1) as ApprovalRequestEvent;
  session.send({ kind: "line", text: "n" });
  session.send({ kind: "inputEnded" });
  const rest = await until(events, "ended");
  expect(rest).toContainEqual({
    kind: "approvalAnswered",
    id: request.id,
    answer: "refuse",
  });
  expect(answers).toEqual([false]);
});

test("a line the page sent before it showed the question does not answer it", async () => {
  const answers: boolean[] = [];
  const session = startSession(portsFor(answers));
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "go" });
  const asked = await until(events, "approvalRequest");
  const request = asked.at(-1) as ApprovalRequestEvent;
  session.send({ kind: "line", text: "y", shown: 0 });
  const notice = await until(events, "notice");
  expect(notice.at(-1)?.kind).toBe("notice");
  expect(answers).toEqual([]);
  session.send({ kind: "approval", id: request.id, answer: "approve" });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
  expect(answers).toEqual([true]);
});

test("/help is answered by the session with the description of the named command", async () => {
  const session = startSession(portsFor([]));
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "/help model" });
  const seen = await until(events, "ready");
  const notice = seen.find((event) => event.kind === "notice");
  expect(notice?.kind === "notice" && notice.text.startsWith("/model [")).toBe(true);
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

// A resume store kept in memory: `saved` records every conversation the session wrote.
interface MemoryResume {
  store: ResumeStore;
  saved: Conversation[];
}

function memoryResume(start?: Conversation): MemoryResume {
  const saved: Conversation[] = [];
  return {
    saved,
    store: {
      load: async () => ok(start),
      save: async (conversation) => {
        saved.push(conversation);
        return ok(undefined);
      },
    },
  };
}

test("the conversation of the last run is shown at the start", async () => {
  const resume = memoryResume({
    history: [
      { role: "user", content: "earlier" },
      { role: "assistant", content: "reply" },
    ],
    compacted: false,
  });
  const session = startSession({ ...portsFor([]), resume: resume.store });
  const events = session.events()[Symbol.asyncIterator]();
  const seen = await until(events, "history");
  expect(seen.at(-1)).toEqual({
    kind: "history",
    messages: [
      { role: "user", text: "earlier" },
      { role: "assistant", text: "reply" },
    ],
  });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

test("each line saves the conversation, and /new saves an empty one", async () => {
  const resume = memoryResume();
  const session = startSession({ ...portsFor([]), resume: resume.store });
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "/help model" });
  await until(events, "ready");
  expect(resume.saved).toHaveLength(1);
  session.send({ kind: "line", text: "/new" });
  const seen = await until(events, "ready");
  expect(seen).toContainEqual({ kind: "history", messages: [] });
  expect(resume.saved.at(-1)?.history).toEqual([]);
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});
