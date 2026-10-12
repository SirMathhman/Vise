import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noAudit } from "@vise/core";
import { createToolRunner, ToolSet, tools } from "../../../src/tools.ts";
import { readFile } from "../../../src/tools/files.ts";
import { killProcess, runPowershell, waitForProcess } from "../../../src/tools/shell.ts";

test("a failing file tool returns an error: result, never a bare message", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "vise-err-")), "nope.txt");
  expect(readFile({ path: missing }).startsWith("error:")).toBe(true);
});

test("wait_for_process without a timeout polls instead of failing", async () => {
  const id = await runPowershell({ command: "Start-Sleep -Seconds 5", background: true });
  const text = await waitForProcess({ process_id: Number(id) });
  expect(text.startsWith("error:")).toBe(false);
  expect(text).toContain("still running");
  killProcess({ process_id: Number(id) });
});

test("a handler that throws is audited as failed and the model gets its message", async () => {
  const events: { ok: boolean; result: string }[] = [];
  const audit = {
    ...noAudit,
    record: (e: { kind: string; ok?: boolean; result?: string }) => {
      if (e.kind === "tool_call") events.push({ ok: e.ok ?? true, result: e.result ?? "" });
    },
  };
  const runner = createToolRunner(
    {
      list_directory: () => {
        throw new Error("boom");
      },
    },
    new ToolSet(tools),
    process.cwd(),
    undefined,
    undefined,
    undefined,
    audit as never,
  );
  const result = await runner.run("list_directory", { path: "." });
  expect(result).toBe("error: boom");
  expect(events[0]?.ok).toBe(false);
});
