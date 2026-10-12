import { expect, test } from "bun:test";
import type { AuditEvent } from "@vise/core";
import { noAudit } from "@vise/core";
import type { ToolHookEntry } from "@vise/core";
import { createToolRunner, ToolSet, tools } from "../../../src/tools.ts";
import { ShellToolHooks } from "../../../src/tools/hooks/tool-hooks.ts";
import { TempStore } from "../../../src/tools/temp-store.ts";

/** A runner whose `list_directory` (category files) is a stub that records its calls. */
function setup(
  pre: ToolHookEntry[],
  post: ToolHookEntry[],
  result = "listing",
  spill?: TempStore,
) {
  const calls: Record<string, unknown>[] = [];
  const events: AuditEvent[] = [];
  const audit = { ...noAudit, record: (e: AuditEvent) => void events.push(e) };
  const runner = createToolRunner(
    {
      list_directory: (args) => {
        calls.push(args);
        return result;
      },
    },
    new ToolSet(tools),
    process.cwd(),
    undefined,
    spill,
    undefined,
    audit,
    new ShellToolHooks(pre, post, process.cwd(), audit),
  );
  return { runner, calls, events };
}

test("a pre-tool hook that exits 2 blocks the call and the model sees why", async () => {
  const { runner, calls } = setup(
    [{ command: "Write-Output 'no listing here'; exit 2" }],
    [],
  );
  const out = await runner.run("list_directory", { path: "." });
  expect(out).toBe("error: blocked by pre-tool hook: no listing here");
  expect(calls).toHaveLength(0);
});

test("a pre-tool hook that fails any other way does not stop the call", async () => {
  const { runner, calls, events } = setup([{ command: "exit 1" }], []);
  expect(await runner.run("list_directory", { path: "." })).toBe("listing");
  expect(calls).toHaveLength(1);
  const run = events.find((e) => e.kind === "hook_run");
  expect(run).toMatchObject({ phase: "pre_tool", tool: "list_directory", status: 1 });
});

test("a post-tool hook's output is added to the result", async () => {
  const { runner } = setup([], [{ command: "Write-Output 'lint ok'" }]);
  expect(await runner.run("list_directory", { path: "." })).toBe(
    "listing\n[post-tool hook: lint ok]",
  );
});

test("a post-tool hook that prints nothing leaves the result alone", async () => {
  const { runner } = setup([], [{ command: "exit 0" }]);
  expect(await runner.run("list_directory", { path: "." })).toBe("listing");
});

test("hooks see the call in their environment and on standard input", async () => {
  const { runner } = setup(
    [],
    [
      {
        command:
          "$in = [Console]::In.ReadToEnd() | ConvertFrom-Json; " +
          "Write-Output \"$env:VISE_TOOL_NAME $env:VISE_TOOL_OK $env:VISE_TOOL_DEPTH $($in.phase) $($in.args.path) $($in.result)\"",
      },
    ],
  );
  const out = await runner.run("list_directory", { path: "src" });
  expect(out).toBe("listing\n[post-tool hook: list_directory 1 0 post_tool src listing]");
});

test("a tool filter limits a hook to those tools or categories", async () => {
  const { runner } = setup(
    [
      { command: "exit 2", tools: ["shell"] },
      { command: "Write-Output 'by name'; exit 2", tools: ["read_file"] },
    ],
    [
      { command: "Write-Output 'by category'", tools: ["files"] },
      { command: "Write-Output 'never'", tools: ["notes"] },
    ],
  );
  expect(await runner.run("list_directory", { path: "." })).toBe(
    "listing\n[post-tool hook: by category]",
  );
});

test("a call the runner refuses never reaches the hooks", async () => {
  const { runner, events } = setup([{ command: "exit 2" }], []);
  const out = await runner.run("no_such_tool", {});
  expect(out).toBe("error: unknown tool no_such_tool");
  expect(events.some((e) => e.kind === "hook_run")).toBe(false);
});

test("a result too big to show is saved, and the hook note follows the pointer", async () => {
  const temp = new TempStore();
  try {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const { runner } = setup([], [{ command: "Write-Output 'checked'" }], big, temp);
    const out = await runner.run("list_directory", { path: "." });
    expect(out).toContain("read_temp");
    expect(out.endsWith("[post-tool hook: checked]")).toBe(true);
  } finally {
    temp.dispose();
  }
});
