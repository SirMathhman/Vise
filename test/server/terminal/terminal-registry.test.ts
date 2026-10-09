import { describe, expect, test } from "bun:test";
import type { PtyProcess } from "../../../src/web/terminal/pty.ts";
import { Scrollback } from "../../../src/web/terminal/scrollback.ts";
import { handleTerminalMessage, terminalSize } from "../../../src/web/terminal/terminal-api.ts";
import { TerminalRegistry, type Timers } from "../../../src/web/terminal/terminal-registry.ts";

class FakePty implements PtyProcess {
  readonly pid = 42;
  written: string[] = [];
  sizes: [number, number][] = [];
  killed = false;
  data: (text: string) => void = () => {};
  exit: (code: number) => void = () => {};
  constructor(readonly options: { command: string; cwd: string; cols: number; rows: number }) {}
  write(data: string): void {
    this.written.push(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  onData(listener: (text: string) => void): void {
    this.data = listener;
  }
  onExit(listener: (code: number) => void): void {
    this.exit = listener;
  }
}

function setup() {
  const spawned: FakePty[] = [];
  const pending: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const timers: Timers = {
    set: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      pending.push(timer);
      return timer;
    },
    clear: (timer) => ((timer as (typeof pending)[number]).cleared = true),
  };
  const registry = new TerminalRegistry(
    (options) => {
      const pty = new FakePty(options);
      spawned.push(pty);
      return pty;
    },
    () => ({ shell: "sh", idleMs: 1000, scrollbackChars: 1000 }),
    timers,
  );
  const page = () => {
    const got: Record<string, unknown>[] = [];
    return { got, send: (msg: Record<string, unknown>) => void got.push(msg) };
  };
  const fire = () => pending.filter((t) => !t.cleared).forEach((t) => t.callback());
  return { registry, spawned, pending, page, fire };
}

describe("TerminalRegistry", () => {
  test("opening starts one shell in the folder at the page's size", () => {
    const { registry, spawned, page } = setup();
    const a = registry.attach("C:/proj", page().send);
    a.open(100, 30);
    a.open(100, 30);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.options).toEqual({ command: "sh", cwd: "C:/proj", cols: 100, rows: 30 });
  });

  test("output reaches every page on the folder, and a later page gets it replayed", () => {
    const { registry, spawned, page } = setup();
    const one = page();
    registry.attach("r", one.send).open(80, 24);
    spawned[0]!.data("hello\r\n");
    const two = page();
    registry.attach("r", two.send).open(80, 24);
    spawned[0]!.data("more");
    expect(spawned).toHaveLength(1);
    expect(two.got).toEqual([
      { type: "term_data", data: "hello\r\n", replay: true },
      { type: "term_data", data: "more" },
    ]);
    expect(one.got.filter((m) => !m.replay).map((m) => m.data)).toEqual(["hello\r\n", "more"]);
  });

  test("a page that never opened the terminal gets nothing and keeps no shell alive", () => {
    const { registry, spawned, page, pending } = setup();
    const quiet = page();
    const q = registry.attach("r", quiet.send);
    const a = registry.attach("r", page().send);
    a.open(80, 24);
    spawned[0]!.data("x");
    expect(quiet.got).toEqual([]);
    q.detach();
    expect(pending).toHaveLength(0);
  });

  test("input and resize go to the shell", () => {
    const { registry, spawned, page } = setup();
    const a = registry.attach("r", page().send);
    a.open(80, 24);
    a.input("dir\r");
    a.resize(120, 40);
    expect(spawned[0]!.written).toEqual(["dir\r"]);
    expect(spawned[0]!.sizes).toContainEqual([120, 40]);
  });

  test("with no page left the shell is stopped after the idle time", () => {
    const { registry, spawned, page, pending, fire } = setup();
    const a = registry.attach("r", page().send);
    a.open(80, 24);
    a.detach();
    expect(spawned[0]!.killed).toBe(false);
    expect(pending[0]!.ms).toBe(1000);
    fire();
    expect(spawned[0]!.killed).toBe(true);
    // A new page starts a new shell.
    registry.attach("r", page().send).open(80, 24);
    expect(spawned).toHaveLength(2);
  });

  test("a page that comes back before the idle time keeps the same shell", () => {
    const { registry, spawned, page, fire } = setup();
    registry.attach("r", page().send).open(80, 24);
    registry.attach("r", page().send).detach(); // never opened: no effect
    const first = registry.attach("r", page().send);
    first.open(80, 24);
    first.detach();
    registry.attach("r", page().send).open(80, 24); // the reload
    fire();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.killed).toBe(false);
  });

  test("an exit is reported to every page, and restart starts a fresh shell", () => {
    const { registry, spawned, page } = setup();
    const one = page();
    const two = page();
    const a = registry.attach("r", one.send);
    a.open(80, 24);
    registry.attach("r", two.send).open(80, 24);
    spawned[0]!.data("old output");
    spawned[0]!.exit(3);
    expect(one.got).toContainEqual({ type: "term_exit", code: 3 });
    expect(two.got).toContainEqual({ type: "term_exit", code: 3 });
    a.restart();
    expect(spawned).toHaveLength(2);
    expect(two.got.at(-1)).toEqual({ type: "term_data", data: "", replay: true });
    // The new shell starts with an empty scrollback.
    const three = page();
    registry.attach("r", three.send).open(80, 24);
    expect(three.got[0]).toEqual({ type: "term_data", data: "", replay: true });
  });

  test("the old shell's late exit does not end the restarted one", () => {
    const { registry, spawned, page } = setup();
    const one = page();
    const a = registry.attach("r", one.send);
    a.open(80, 24);
    a.restart();
    expect(spawned[0]!.killed).toBe(true);
    spawned[0]!.exit(1);
    expect(one.got).not.toContainEqual({ type: "term_exit", code: 1 });
    expect(registry.running()).toBe(1);
  });

  test("a shell that cannot start is reported to the page that asked", () => {
    const registry = new TerminalRegistry(() => {
      throw new Error("the integrated terminal is Windows-only (ConPTY)");
    });
    const got: Record<string, unknown>[] = [];
    registry.attach("r", (m) => void got.push(m)).open(80, 24);
    expect(got).toEqual([
      { type: "term_data", data: "", replay: true },
      { type: "term_error", message: "the integrated terminal is Windows-only (ConPTY)" },
    ]);
  });

  test("closeAll stops every shell", () => {
    const { registry, spawned, page } = setup();
    registry.attach("a", page().send).open(80, 24);
    registry.attach("b", page().send).open(80, 24);
    registry.closeAll();
    expect(spawned.every((p) => p.killed)).toBe(true);
  });
});

describe("terminal messages", () => {
  test("sizes are clamped integers, with a fallback for anything else", () => {
    expect(terminalSize(120.4, 80)).toBe(120);
    expect(terminalSize(0, 80)).toBe(1);
    expect(terminalSize(10_000, 80)).toBe(500);
    expect(terminalSize("90", 80)).toBe(80);
    expect(terminalSize(Number.NaN, 24)).toBe(24);
  });

  test("input that is not text is ignored, and a session without a terminal says so", () => {
    const { registry, spawned, page } = setup();
    const a = registry.attach("r", page().send);
    const replies: Record<string, unknown>[] = [];
    const send = (m: Record<string, unknown>) => void replies.push(m);
    handleTerminalMessage(a, { type: "term_open", cols: 90, rows: "x" }, send);
    handleTerminalMessage(a, { type: "term_input", data: 5 }, send);
    handleTerminalMessage(a, { type: "term_input", data: "ls" }, send);
    expect(spawned[0]!.options.cols).toBe(90);
    expect(spawned[0]!.options.rows).toBe(24);
    expect(spawned[0]!.written).toEqual(["ls"]);
    handleTerminalMessage(null, { type: "term_open" }, send);
    expect(replies).toEqual([{ type: "term_error", message: "no terminal: this session has no folder" }]);
  });
});

describe("Scrollback", () => {
  test("keeps everything under the cap", () => {
    const s = new Scrollback(() => 100);
    s.push("a\n");
    s.push("b");
    expect(s.text()).toBe("a\nb");
  });

  test("drops the oldest text first, from a line start", () => {
    const s = new Scrollback(() => 10);
    s.push("first line\n");
    s.push("second\nthird");
    expect(s.text()).toBe("third");
    expect(s.text().length).toBeLessThanOrEqual(10);
  });

  test("clear empties it", () => {
    const s = new Scrollback(() => 10);
    s.push("x");
    s.clear();
    expect(s.text()).toBe("");
  });
});
