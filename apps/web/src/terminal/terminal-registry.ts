// The integrated terminal's shells: one per folder, shared by every page open
// on that folder and kept across page reloads. A page attaches; it becomes a
// viewer when it opens the terminal, and gets the recent output replayed. With
// no viewer left the shell is stopped after an idle time.

import { config } from "@vise/backend";
import type { PtyProcess, SpawnPty } from "./pty.ts";
import { Scrollback } from "./scrollback.ts";

type Send = (msg: Record<string, unknown>) => void;

export interface TerminalSettings {
  /** The shell's command line. */
  shell: string;
  /** How long a shell with no page open on it lives on (ms). */
  idleMs: number;
  /** How much output is kept for a page that attaches later (characters). */
  scrollbackChars: number;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

/** One page's handle on its folder's terminal. */
export interface TerminalAttachment {
  /** Show the terminal: start the shell if there is none, else replay its recent output. */
  open(cols: number, rows: number): void;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  /** Start a new shell (after the old one exited, or replacing it). */
  restart(): void;
  /** Stop the shell. */
  close(): void;
  /** The page went away. */
  detach(): void;
}

interface Shell {
  pty: PtyProcess | null;
  scrollback: Scrollback;
  viewers: Set<Send>;
  idle: unknown;
  cols: number;
  rows: number;
}

const liveSettings = (): TerminalSettings => ({
  shell: config.terminalShell,
  idleMs: config.terminalIdleMinutes * 60_000,
  scrollbackChars: config.terminalScrollbackKb * 1024,
});

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export class TerminalRegistry {
  private readonly shells = new Map<string, Shell>();

  constructor(
    private readonly spawn: SpawnPty,
    private readonly settings: () => TerminalSettings = liveSettings,
    private readonly timers: Timers = realTimers,
  ) {}

  /** How many shells are running (for tests and diagnostics). */
  running(): number {
    return [...this.shells.values()].filter((s) => s.pty).length;
  }

  attach(root: string, send: Send): TerminalAttachment {
    const shellOf = (): Shell | undefined => this.shells.get(root);
    return {
      open: (cols, rows) => this.open(root, send, cols, rows),
      input: (data) => shellOf()?.pty?.write(data),
      resize: (cols, rows) => {
        const shell = shellOf();
        if (!shell || !shell.viewers.has(send)) return;
        shell.cols = cols;
        shell.rows = rows;
        shell.pty?.resize(cols, rows);
      },
      restart: () => {
        const shell = shellOf();
        if (!shell || !shell.viewers.has(send)) return;
        const old = shell.pty;
        shell.pty = null; // its exit is no longer this shell's
        old?.kill();
        this.startFresh(root, shell, send);
      },
      close: () => shellOf()?.pty?.kill(),
      detach: () => this.detach(root, send),
    };
  }

  /** Stop every shell (the server is shutting down). */
  closeAll(): void {
    for (const shell of this.shells.values()) {
      if (shell.idle !== undefined) this.timers.clear(shell.idle);
      shell.pty?.kill();
    }
    this.shells.clear();
  }

  private open(root: string, send: Send, cols: number, rows: number): void {
    let shell = this.shells.get(root);
    if (!shell) {
      const settings = this.settings;
      shell = {
        pty: null,
        scrollback: new Scrollback(() => settings().scrollbackChars),
        viewers: new Set(),
        idle: undefined,
        cols,
        rows,
      };
      this.shells.set(root, shell);
    }
    if (shell.idle !== undefined) {
      this.timers.clear(shell.idle);
      shell.idle = undefined;
    }
    shell.viewers.add(send);
    shell.cols = cols;
    shell.rows = rows;
    if (!shell.pty) {
      this.startFresh(root, shell, send);
      return;
    }
    send({ type: "term_data", data: shell.scrollback.text(), replay: true });
    shell.pty.resize(cols, rows);
  }

  /** Start a new shell with an empty screen on every page that shows it. */
  private startFresh(root: string, shell: Shell, requester: Send): void {
    shell.scrollback.clear();
    for (const viewer of shell.viewers) viewer({ type: "term_data", data: "", replay: true });
    this.start(root, shell, requester);
  }

  private start(root: string, shell: Shell, requester: Send): void {
    let pty: PtyProcess;
    try {
      pty = this.spawn({
        command: this.settings().shell,
        cwd: root,
        cols: shell.cols,
        rows: shell.rows,
      });
    } catch (error) {
      requester({
        type: "term_error",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    shell.pty = pty;
    pty.onData((text) => {
      if (shell.pty !== pty) return;
      shell.scrollback.push(text);
      for (const viewer of shell.viewers) viewer({ type: "term_data", data: text });
    });
    pty.onExit((code) => {
      if (shell.pty !== pty) return;
      shell.pty = null;
      for (const viewer of shell.viewers) viewer({ type: "term_exit", code });
      if (shell.viewers.size === 0) this.forget(root, shell);
    });
  }

  private detach(root: string, send: Send): void {
    const shell = this.shells.get(root);
    if (!shell || !shell.viewers.delete(send) || shell.viewers.size > 0) return;
    if (!shell.pty) {
      this.forget(root, shell);
      return;
    }
    shell.idle = this.timers.set(() => {
      shell.idle = undefined;
      const pty = shell.pty;
      this.forget(root, shell);
      pty?.kill();
    }, this.settings().idleMs);
  }

  private forget(root: string, shell: Shell): void {
    if (this.shells.get(root) === shell) this.shells.delete(root);
  }
}
