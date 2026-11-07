import { expect, test } from "bun:test";
import type { ReplyRequest } from "../core/messages.ts";
import { toolNames } from "../core/tools.ts";
import type { Conversation } from "../core/compaction.ts";
import type { ProfileDetail } from "../core/notes.ts";
import type { ResumeStore, SessionStore } from "../core/sessions.ts";
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

test("a profile saved with a conversation is not restored when the session resumes", async () => {
  const resume = memoryResume({
    history: [{ role: "user", content: "earlier" }],
    compacted: false,
    profile: {
      name: "terse",
      text: "be brief",
      hooks: [{ point: "sessionStart", command: "echo hi" }],
    },
    pendingProfile: "be brief",
  });
  const session = startSession({ ...portsFor([]), resume: resume.store });
  const events = session.events()[Symbol.asyncIterator]();
  await until(events, "history");
  session.send({ kind: "line", text: "/help model" });
  await until(events, "ready");
  expect(resume.saved.at(-1)?.profile).toBeUndefined();
  expect(resume.saved.at(-1)?.pendingProfile).toBeUndefined();
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

test("the saved sessions are announced at the start, so the page can offer them", async () => {
  const ports = {
    ...portsFor([]),
    sessions: {
      save: async () => ok(undefined),
      load: async () => err(new Error("none")),
      list: async () => ok(["work", "bad name"]),
    },
  };
  const session = startSession(ports);
  const events = session.events()[Symbol.asyncIterator]();
  const seen = await until(events, "sessions");
  expect(seen.at(-1)).toEqual({ kind: "sessions", names: ["work"] });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

test("the tool switches are announced, and a /tools change is announced again", async () => {
  const session = startSession(portsFor([]));
  const events = session.events()[Symbol.asyncIterator]();
  const first = await until(events, "tools");
  const switches = first.at(-1);
  expect(switches?.kind === "tools" && switches.tools.every((tool) => tool.enabled)).toBe(true);
  const tool = toolNames[0]!;
  session.send({ kind: "line", text: `/tools disable ${tool}` });
  const second = await until(events, "tools");
  expect(second.at(-1)).toEqual({
    kind: "tools",
    tools: expect.arrayContaining([{ name: tool, enabled: false }]),
  });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

test("/new keeps the tool switches the user has changed in this run", async () => {
  const session = startSession(portsFor([]));
  const events = session.events()[Symbol.asyncIterator]();
  await until(events, "tools");
  const tool = toolNames[0]!;
  session.send({ kind: "line", text: `/tools disable ${tool}` });
  await until(events, "tools");
  session.send({ kind: "line", text: "/new" });
  const after = await until(events, "tools");
  expect(after.at(-1)).toEqual({
    kind: "tools",
    tools: expect.arrayContaining([{ name: tool, enabled: false }]),
  });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

test("a profile is read for the page, and an edited profile is saved and listed again", async () => {
  const detail = { name: "plan", summary: "s", hooks: [], text: "Plan." };
  const written: ProfileDetail[] = [];
  const profiles = {
    list: async () => ok([{ name: "plan", summary: "s" }]),
    read: async (name: string) => (name === "plan" ? ok(detail) : err(new Error("none"))),
    write: async (profile: ProfileDetail) => {
      written.push(profile);
      return ok(undefined);
    },
  };
  const session = startSession({ ...portsFor([]), profiles });
  const events = session.events()[Symbol.asyncIterator]();
  await until(events, "profiles");
  session.send({ kind: "profileRead", name: "plan" });
  const read = await until(events, "profile");
  expect(read.at(-1)).toEqual({ kind: "profile", profile: detail });
  session.send({ kind: "profileWrite", profile: { ...detail, text: "Plan again." } });
  const saved = await until(events, "profiles");
  expect(written).toEqual([{ ...detail, text: "Plan again." }]);
  expect(saved.at(-1)).toEqual({ kind: "profiles", profiles: [{ name: "plan", summary: "s" }] });
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

test("a note command sends the profile list again, so a profile it creates shows on the page", async () => {
  const profiles = {
    list: async () => ok([{ name: "plan", summary: "" }]),
    read: async () => err(new Error("none")),
    write: async () => ok(undefined),
  };
  const session = startSession({ ...portsFor([]), profiles });
  const events = session.events()[Symbol.asyncIterator]();
  await until(events, "profiles");
  session.send({ kind: "line", text: "/note list" });
  const seen = await until(events, "ready");
  expect(seen.some((event) => event.kind === "profiles")).toBe(true);
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

// A model that answers with text, and saved sessions kept in memory.
async function* textReply(): AsyncGenerator<Result<string>> {
  yield ok("an answer");
}

function memorySessions(saved: Map<string, string>): SessionStore {
  return {
    save: async (name, text) => {
      saved.set(name, text);
      return ok(undefined);
    },
    load: async (name) => {
      const text = saved.get(name);
      return text === undefined ? err(new Error("none")) : ok(text);
    },
    list: async () => ok([...saved.keys()]),
  };
}

test("the first message names the autosave session, and later lines keep saving to it", async () => {
  const saved = new Map<string, string>();
  const session = startSession({ ...portsFor([]), reply: textReply, sessions: memorySessions(saved) });
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "How do I parse JSON?" });
  await until(events, "ready");
  expect([...saved.keys()]).toEqual(["how-do-i-parse-json"]);
  session.send({ kind: "line", text: "Thanks" });
  await until(events, "ready");
  expect([...saved.keys()]).toEqual(["how-do-i-parse-json"]);
  expect(saved.get("how-do-i-parse-json")).toContain("Thanks");
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

test("after /new, the next first message gets a new name, and a taken name gets a suffix", async () => {
  const saved = new Map<string, string>();
  const session = startSession({ ...portsFor([]), reply: textReply, sessions: memorySessions(saved) });
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "How do I parse JSON?" });
  await until(events, "ready");
  session.send({ kind: "line", text: "/new" });
  await until(events, "ready");
  session.send({ kind: "line", text: "How do I parse JSON?" });
  await until(events, "ready");
  expect([...saved.keys()].sort()).toEqual(["how-do-i-parse-json", "how-do-i-parse-json-2"]);
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});

test("after /load, later messages keep saving to the loaded session", async () => {
  const saved = new Map<string, string>([
    ["work", '{"version":1,"history":[],"compacted":false}'],
  ]);
  const session = startSession({ ...portsFor([]), reply: textReply, sessions: memorySessions(saved) });
  const events = session.events()[Symbol.asyncIterator]();
  session.send({ kind: "line", text: "/load work" });
  await until(events, "ready");
  session.send({ kind: "line", text: "Hello again" });
  await until(events, "ready");
  expect([...saved.keys()]).toEqual(["work"]);
  expect(saved.get("work")).toContain("Hello again");
  session.send({ kind: "inputEnded" });
  await until(events, "ended");
});
