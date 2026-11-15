import type { Readable, Writable } from "node:stream";
import { startSession } from "../backend/session.ts";
import type { SessionPorts } from "../backend/ports.ts";
import { type ReplyRequest, err, ok, type Result } from "../core/messages.ts";
import { toolNames } from "../core/tools.ts";
import { runRepl } from "./repl.ts";

// A reply that echoes the last message, for tests that do not need the model.
export async function* echoReply({
  messages,
}: ReplyRequest): AsyncGenerator<Result<string>> {
  yield ok(`echo: ${messages.at(-1)?.content ?? ""}`);
}

// The ports a test session uses. Each test overrides only the ports it needs.
export function ports(overrides: Partial<SessionPorts> = {}): SessionPorts {
  return {
    allTools: toolNames,
    reply: echoReply,
    contextWindow: async () =>
      err(new Error("no context window is configured")),
    tools: async () => "no tools are available",
    notes: async () => "notes are not available",
    profile: async () => err(new Error("no profiles are available")),
    profileTools: async () => ok(undefined),
    profileHooks: async () => ok([]),
    hooks: async () => ok(""),
    models: {
      current: () => "m",
      list: async () => ok([]),
      select: async (name: string) => ok(name),
    },
    disabledTools: [],
    saveDisabledTools: async () => ok(undefined),
    sessions: {
      save: async () => ok(undefined),
      load: async () => err(new Error("none")),
      list: async () => ok([]),
    },
    ...overrides,
  };
}

// Runs a session with the given ports, reading its lines from `input`, until it ends. Tests use this
// to drive the whole stack: the backend session and the terminal frontend.
export function runWithPorts(
  input: Readable,
  output: Writable,
  ports: SessionPorts,
): ReturnType<typeof runRepl> {
  return runRepl(input, output, startSession(ports));
}
