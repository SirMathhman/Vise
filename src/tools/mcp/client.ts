import { err, ok, type Result } from "../../core/messages.ts";
import { childEnvironment } from "../process/child-env.ts";

// One MCP server over stdio: JSON-RPC 2.0, one message per line. A request that gets no answer in
// time fails, so a server that hangs cannot hold the session.
export const REQUEST_TIMEOUT_MS = 60_000;

export interface McpSession {
  request(method: string, params: unknown): Promise<Result<unknown>>;
  notify(method: string, params: unknown): void;
  stop(): Promise<void>;
}

type Answer = (result: Result<unknown>) => void;

// Starts the server in the working directory. Fails when the command cannot be started.
export function openSession(
  command: string,
  args: string[],
  cwd: string,
): Result<McpSession> {
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    proc = Bun.spawn([command, ...args], {
      cwd,
      env: childEnvironment(process.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  const pending = new Map<number, Answer>();
  let nextId = 1;
  let closed = false;

  const close = (reason: string): void => {
    closed = true;
    for (const answer of pending.values()) answer(err(new Error(reason)));
    pending.clear();
  };
  const write = (message: object): void => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
    proc.stdin.flush();
  };
  const handle = (line: string): void => {
    const message = parseMessage(line);
    if (message === undefined || typeof message.id !== "number") return;
    const answer = pending.get(message.id);
    if (answer === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) {
      answer(err(new Error(message.error.message ?? "the server returned an error")));
    } else {
      answer(ok(message.result));
    }
  };
  void readLines(proc.stdout, handle).then(() => close("the server stopped"));

  return ok({
    request(method, params) {
      if (closed) return Promise.resolve(err(new Error("the server has stopped")));
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(err(new Error(`${method} got no answer in time`)));
        }, REQUEST_TIMEOUT_MS);
        pending.set(id, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      if (!closed) write({ jsonrpc: "2.0", method, params });
    },
    async stop() {
      close("the server was stopped");
      proc.kill();
      await proc.exited;
    },
  });
}

interface WireMessage {
  id?: unknown;
  result?: unknown;
  error?: WireError;
}

interface WireError {
  message?: string;
}

function parseMessage(line: string): WireMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as WireMessage) : undefined;
  } catch {
    return undefined;
  }
}

// Calls `onLine` for each complete line the stream produces, and the rest when it ends.
async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      onLine(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf("\n");
    }
  }
  if (buffer.trim() !== "") onLine(buffer);
}
