import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const RUN_TIMEOUT_MS = 30_000;
const RUNNER = fileURLToPath(
  new URL("./playwright-runner.mjs", import.meta.url),
);

interface Pending {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs Playwright snippets against a tab of the browser Vise launched. The
 * snippets execute in a separate Node process (`playwright-runner.mjs`):
 * Playwright's CDP transport does not work under Bun, and a snippet is
 * arbitrary code that should not share the server's process. Needs `node` on
 * the PATH. The runner starts on first use and is shut down with `close()`.
 */
export class PlaywrightSession {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly wsUrl: () => string) {}

  /**
   * Run `code` as the body of an async function with `page` in scope and
   * return its JSON-encoded result. Gives up (and restarts the runner) after
   * 30 seconds.
   */
  run(targetId: string, code: string): Promise<string> {
    const child = this.runner();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`snippet timed out after ${RUN_TIMEOUT_MS} ms`));
        this.stop();
      }, RUN_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin?.write(
        `${JSON.stringify({ id, wsUrl: this.wsUrl(), targetId, code })}\n`,
      );
    });
  }

  close(): Promise<void> {
    this.stop();
    return Promise.resolve();
  }

  private runner(): ChildProcess {
    if (this.child) return this.child;
    const child = spawn("node", [RUNNER], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    child.on("error", (error) =>
      this.failAll(`cannot start node: ${error.message}`),
    );
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      this.failAll("the Playwright runner exited");
    });
    createInterface({ input: child.stdout! }).on("line", (line) =>
      this.onLine(line),
    );
    this.child = child;
    return child;
  }

  private onLine(line: string): void {
    let reply: { id: number; ok: boolean; result?: string; error?: string };
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.result ?? "done");
    else pending.reject(new Error(reply.error ?? "snippet failed"));
  }

  private failAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** End the runner; closing its stdin makes it disconnect from the browser and exit. */
  private stop(): void {
    const child = this.child;
    this.child = null;
    child?.stdin?.end();
    // A runner stuck in a snippet will not notice stdin closing.
    setTimeout(() => child?.kill(), 2000).unref();
  }
}
