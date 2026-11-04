export interface ExitLine {
  kind: "exit";
}

export interface ContextLine {
  kind: "context";
}

export interface UnknownCommandLine {
  kind: "unknown-command";
  command: string;
}

export interface MessageLine {
  kind: "message";
  text: string;
}

export type Line = ExitLine | ContextLine | UnknownCommandLine | MessageLine;

// Decides what a line means. Commands are matched on the trimmed line. Other
// lines starting with "/" are rejected, and everything else is a message for
// the model, sent exactly as typed.
export function classifyLine(line: string): Line {
  const command = line.trim();
  if (command === "/exit") return { kind: "exit" };
  if (command === "/context") return { kind: "context" };
  if (command.startsWith("/")) return { kind: "unknown-command", command };
  return { kind: "message", text: line };
}

export function contextLine(used: number | undefined, total: number | undefined): string {
  if (used === undefined) return "context: no request sent yet";
  return `context: ${used} / ${total ?? "unknown"} tokens`;
}
