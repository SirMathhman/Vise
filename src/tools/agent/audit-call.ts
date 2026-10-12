import type { AuditSink } from "../../core/audit.ts";
import { errStr } from "../files.ts";
import { currentSubagentDepth } from "./subagent.ts";

/** Run a tool handler and record the call: its whole result (or the exception) and how long it took. */
export async function auditCall(
  audit: AuditSink,
  name: string,
  args: Record<string, unknown>,
  run: () => string | Promise<string>,
): Promise<string> {
  const started = performance.now();
  let result: string;
  try {
    result = await run();
  } catch (e) {
    // A handler that throws still gives the model its message (and is audited as failed).
    result = errStr(e);
  }
  record(audit, name, args, result, started);
  return result;
}

/** A call the runner refused (unknown or not allowed): recorded, and the refusal returned. */
export function auditRefused(
  audit: AuditSink,
  name: string,
  args: Record<string, unknown>,
  refusal: string,
): string {
  record(audit, name, args, refusal, performance.now());
  return refusal;
}

function record(
  audit: AuditSink,
  name: string,
  args: Record<string, unknown>,
  result: string,
  started: number,
): void {
  audit.record({
    kind: "tool_call",
    name,
    args,
    result,
    ok: !result.startsWith("error:"),
    ms: performance.now() - started,
    depth: currentSubagentDepth(),
  });
}
