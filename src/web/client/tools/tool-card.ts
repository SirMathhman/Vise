import type { ToolBlock } from "../state.ts";

// A tool call in the transcript: a card with a symbol for its tool, the tool's name, its arguments, and its result
// folded under it. The symbols are plain characters, so they take the page's colours and need no images.

const SYMBOLS: Record<string, string> = {
  list_files: "≡",
  read_file: "¶",
  edit_file: "✎",
  create_file: "+",
  run_powershell: "$",
  read_command: "⋯",
  kill_command: "×",
  create_note: "✦",
  run_subagent: "⇢",
  ask_user: "?",
};

// The tool's name and its arguments, from the call's description ("tool: <name> <arguments>").
export interface Call {
  name: string;
  args: string;
}

export function callOf(description: string): Call {
  const [, name = "", ...rest] = description.replace(/^tool: /, "").split(" ");
  return { name, args: rest.join(" ") };
}

export function toolCard(doc: Document, block: ToolBlock): HTMLElement {
  const { name, args } = callOf(block.description);
  const card = doc.createElement("div");
  card.className = block.skipped ? "block tool-card skipped" : "block tool-card";
  const head = doc.createElement("div");
  head.className = "tool-head";
  const symbol = doc.createElement("span");
  symbol.className = "tool-symbol";
  symbol.setAttribute("aria-hidden", "true");
  symbol.textContent = SYMBOLS[name] ?? "◆";
  const label = doc.createElement("span");
  label.className = "tool-name";
  label.textContent = name;
  const argsNode = doc.createElement("span");
  argsNode.className = "tool-args";
  argsNode.textContent = args;
  head.append(symbol, label, argsNode);
  if (block.skipped) {
    const note = doc.createElement("span");
    note.className = "tool-note";
    note.textContent = "did not run: the session ended";
    head.append(note);
  }
  card.append(head);
  if (block.result !== undefined) {
    const details = doc.createElement("details");
    details.className = "tool-result";
    const summary = doc.createElement("summary");
    summary.textContent = "Result";
    const text = doc.createElement("pre");
    text.textContent = block.result;
    details.append(summary, text);
    card.append(details);
  }
  return card;
}
