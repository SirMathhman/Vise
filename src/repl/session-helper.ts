import type { Readable, Writable } from "node:stream";
import { startSession } from "../backend/session.ts";
import type { SessionPorts } from "../backend/ports.ts";
import { type ReplyRequest, ok, type Result } from "../core/messages.ts";
import { runRepl } from "./repl.ts";

// A reply that echoes the last message, for tests that do not need the model.
export async function* echoReply({
  messages,
}: ReplyRequest): AsyncGenerator<Result<string>> {
  yield ok(`echo: ${messages.at(-1)?.content ?? ""}`);
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
