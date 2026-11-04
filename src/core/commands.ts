export type Line =
  | { kind: "exit" }
  | { kind: "context" }
  | { kind: "message"; text: string };

// Decides what a line means. Commands are matched on the trimmed line; anything
// else is a message for the model, sent exactly as typed.
export function classifyLine(line: string): Line {
  const command = line.trim();
  if (command === "/exit") return { kind: "exit" };
  if (command === "/context") return { kind: "context" };
  return { kind: "message", text: line };
}

export function contextLine(used: number | undefined, total: number | undefined): string {
  if (used === undefined) return "context: no request sent yet";
  return `context: ${used} / ${total ?? "unknown"} tokens`;
}
