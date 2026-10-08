import type { AuditReport } from "../core/audit.ts";

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
        "/audit search <text>                      search every recorded conversation",
      ].join("\n");
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
        (r) => `${r.phase} ${r.command} (${r.ms} ms): ${clip(r.output, 60)}`,
      );
    case "search":
      return table(
        "matches",
        report.rows,
        (r) => `${r.kind} in ${r.session.slice(0, 8)}: ${clip(r.snippet)}`,
      );
  }
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
