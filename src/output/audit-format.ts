import type { AuditCall, AuditReport } from "../core/audit.ts";

const clip = (text: string, max = 80): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** An `/audit` answer as lines for the screen. */
export function formatAuditReport(report: AuditReport): string {
  switch (report.topic) {
    case "summary":
      return [
        "audit of this conversation:",
        ...Object.entries(report.counts).map(([k, v]) => `  ${k}: ${v}`),
        "",
        "/audit tools | models | errors | hooks   details",
        "/audit calls [n]                          the latest model calls (running ones first)",
        "/audit call <n>                           one model call: what it wrote, raw",
        "/audit search <text>                      search every recorded conversation",
      ].join("\n");
    case "calls":
      return table("model calls", report.rows, callLine);
    case "call":
      return report.call
        ? formatCall(report.call)
        : `no model call #${report.request} recorded for this conversation (see /audit calls)`;
    case "tools":
      return table(
        "tool calls",
        report.rows,
        (r) =>
          `${r.name}: ${r.calls} calls, ${r.failures} failed, ${r.avgMs} ms on average`,
      );
    case "models":
      return table(
        "model calls",
        report.rows,
        (r) =>
          `${r.purpose}: ${r.calls} calls, ${r.errors} failed, ${r.avgMs} ms on average, up to ${r.maxPromptTokens} prompt tokens`,
      );
    case "errors":
      return table(
        "errors",
        report.rows,
        (r) => `${r.what}: ${clip(r.detail)}`,
      );
    case "hooks":
      return table(
        "hook runs",
        report.rows,
        (r) =>
          `${r.phase}${r.tool ? ` [${r.tool}${r.status === 2 && r.phase === "pre_tool" ? ", blocked" : ""}]` : ""} ${r.command} (${r.ms} ms): ${clip(r.output, 60)}`,
      );
    case "search":
      return table(
        "matches",
        report.rows,
        (r) => `${r.kind} in ${r.session.slice(0, 8)}: ${clip(r.snippet)}`,
      );
  }
}

/** How a call ended, in words: running, ok, or why it was cut short. */
function endOf(call: AuditCall): string {
  if (call.state === "running") return "running";
  if (call.state === "abandoned") return "abandoned (the program ended first)";
  if (call.stopReason === "loop") return "STOPPED: repeating itself";
  if (call.stopReason === "token_cap") return "STOPPED: token cap";
  if (call.stopReason === "interrupted") return "interrupted";
  if (call.state === "error") return "failed";
  return call.finishReason ? `ok (${call.finishReason})` : "ok";
}

function tokens(n: number | undefined): string {
  return n === undefined ? "?" : String(n);
}

/** One row of `/audit calls`. */
function callLine(call: AuditCall): string {
  const seconds = (call.ms / 1000).toFixed(1);
  const repeats = call.loop ? `, loop ×${call.loop.repeats}` : "";
  const calls = call.toolCalls ? `, ${call.toolCalls} tool call(s)` : "";
  return `#${call.request} ${call.purpose}: ${endOf(call)}, ${seconds} s, prompt ${tokens(call.promptTokens)} → wrote ${tokens(call.completionTokens)} tokens${calls}${repeats}`;
}

/** The start and the end of a long text, with what was left out. */
function headAndTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters left out …]\n${text.slice(-tail)}`;
}

/** `/audit call <n>`: one model call, with the raw text it wrote. */
export function formatCall(call: AuditCall): string {
  const lines = [
    `model call #${call.request} (${call.purpose}, ${call.model})`,
    `  ${endOf(call)} after ${(call.ms / 1000).toFixed(1)} s`,
    `  prompt ${tokens(call.promptTokens)} tokens, wrote ${tokens(call.completionTokens)} tokens, ${call.rawChars ?? 0} characters`,
  ];
  if (call.error) lines.push(`  error: ${clip(call.error, 300)}`);
  if (call.loop) {
    lines.push(
      `  the end of it is a ${call.loop.period}-character chunk repeated about ${call.loop.repeats} times:`,
      `    ${JSON.stringify(call.loop.sample ?? "")}`,
    );
  }
  if (call.reasoning) {
    lines.push("", `reasoning (${call.reasoningChars ?? call.reasoning.length} characters, the end):`, headAndTail(call.reasoning, 0, 1500));
  }
  lines.push(
    "",
    call.raw ? "what it wrote, raw:" : "what it wrote: nothing recorded yet",
    ...(call.raw ? [headAndTail(call.raw, 2000, 4000)] : []),
  );
  return lines.join("\n");
}

function table<T>(title: string, rows: T[], line: (row: T) => string): string {
  if (rows.length === 0) return `no ${title} recorded`;
  return [`${title}:`, ...rows.map((r) => `  ${line(r)}`)].join("\n");
}

/** Matches of `/search` in the saved sessions. */
export function formatSearchHits(
  hits: { id: string; name: string; snippet: string }[],
): string {
  if (hits.length === 0) return "no saved session mentions that";
  return [
    "saved sessions that mention it:",
    ...hits.map((h) => `  ${h.name}  (${h.id}): ${clip(h.snippet)}`),
    "",
    "/resume <id>  resume one (an id prefix is enough)",
  ].join("\n");
}
