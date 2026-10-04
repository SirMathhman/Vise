import type { Interface } from "node:readline";
import { cyan, red } from "../output/color.ts";
import { formatCompactionFailure, formatError } from "../output/format.ts";
import type { LineResult, Session } from "../repl/session.ts";
import type { StreamDisplay } from "./stream.ts";

/**
 * Interactive terminal driver (the "frontend"). Owns the surface a human
 * drives: the readline line loop, Ctrl+C handling, the `> ` prompt marker,
 * and per-turn result rendering (streamed vs. whole, errors on stderr). It
 * is a thin adapter over the core's `Session` and the `StreamDisplay` — it
 * performs the turn loop and rendering, and reads the conversation through
 * the session's narrow `LineResult` (invariant #2: edge owns I/O; the session
 * never touches stdin/stdout itself).
 *
 * This is the seam a different frontend plugs into: swap this class for a
 * pipe/script driver (see `pipe.ts` in ARCHITECTURE.md) without touching the
 * core or the session.
 */
export class TerminalDriver {
  private readonly session: Session;
  private readonly display: StreamDisplay;
  private readonly rl: Interface;

  constructor(session: Session, display: StreamDisplay, rl: Interface) {
    this.session = session;
    this.display = display;
    this.rl = rl;
  }

  /**
   * Start the interactive loop: wire the SIGINT and line handlers, write the
   * initial `> ` prompt marker, and begin chaining turns. The readline is
   * created by the wiring in `index.ts` and passed in, so the `ask_user`
   * handler and the `onMaxRounds` callback (both built there) share the same
   * readline-backed prompter.
   */
  run(): void {
    // While a turn is in flight the first Ctrl+C interrupts it (aborting the
    // in-flight model call and stopping the tool loop); at an idle prompt
    // Ctrl+C exits the process. The session is the single source of truth
    // for turn state; no module-level flag is needed.
    this.rl.on("SIGINT", () => {
      if (!this.session.interrupt()) {
        process.exitCode = 130;
        this.rl.close();
      }
    });

    // Colored prompt marker. With `terminal: false`, readline does not manage
    // the echo position; the OS terminal echoes typed characters, so writing
    // the marker here (and after every turn) places it at the start of the
    // line the user is about to type on.
    process.stdout.write(cyan("> "));

    // Chain turns so they never overlap: each line awaits the previous
    // turn's promise before starting its own.
    let chain = Promise.resolve();
    this.rl.on("line", (line) => {
      if (line.trim() === "") return;
      chain = chain.then(async () => {
        const exited = await this.handleLine(line);
        if (exited) this.rl.close();
      });
    });
  }

  /**
   * Handle a single line: reset the display, run the turn through the
   * session, render the result, and re-emit the prompt marker. Returns
   * `true` when the line was `/exit` so the caller can close the readline.
   */
  private async handleLine(line: string): Promise<boolean> {
    this.display.beginTurn();
    const result: LineResult = await this.session.handleLine(line);
    if (result === "exit") return true;
    if (result.ok) {
      // A streamed turn already wrote its reply token-by-token; flush any
      // partial line still buffered and emit the closing newline. Unstreamed
      // results (slash commands, etc.) are printed whole via console.log.
      const streamed = !!result.streamed;
      this.display.finish(streamed);
      if (!streamed) {
        console.log(result.value);
      }
      if (result.compactionWarning) {
        console.error(red(formatCompactionFailure(result.compactionWarning)));
      }
    } else {
      console.error(red(formatError(result.error)));
    }
    process.stdout.write(cyan("> "));
    return false;
  }
}
