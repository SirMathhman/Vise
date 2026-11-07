import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { err, ok, type Result } from "../core/result.ts";
import type { Session } from "../protocol/protocol.ts";
import { createRenderer } from "./render.ts";

// Shows a session in the terminal until it ends. Every line is sent to the session as it is read,
// including the answer to an approval question, which the session reads as the next line. A failure of
// the input or output stream is sent to the session, and the session ends with it. Whatever happens,
// the interface is closed and the listeners are removed before this returns.
export async function runRepl(
  input: Readable,
  output: Writable,
  session: Session,
): Promise<Result<void>> {
  const renderer = createRenderer(output);
  let streamError: Error | undefined;
  // Set once the interface is closed, so no prompt is written after that.
  let closed = false;
  const rl = createInterface({ input, output, prompt: "> " });
  const fail = (error: Error) => {
    streamError ??= error;
    session.send({ kind: "failed", message: error.message });
    closed = true;
    rl.close();
  };
  input.on("error", fail);
  output.on("error", fail);
  // Readline re-emits input errors on the interface, and throws if nothing listens.
  rl.on("error", fail);
  rl.on("line", (line) => session.send({ kind: "line", text: line }));
  rl.once("close", () => {
    closed = true;
    session.send({ kind: "inputEnded" });
  });
  let ended: string | undefined;
  try {
    rl.prompt();
    for await (const event of session.events()) {
      renderer.render(event);
      if (event.kind === "ready" && !closed) rl.prompt();
      if (event.kind === "ended") {
        ended = event.error;
        break;
      }
    }
  } finally {
    input.off("error", fail);
    output.off("error", fail);
    rl.close();
  }
  if (streamError) return err(streamError);
  return ended === undefined ? ok(undefined) : err(new Error(ended));
}
