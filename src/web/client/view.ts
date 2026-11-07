import type { ApprovalAnswer } from "../../protocol/protocol.ts";
import {
  canSend,
  openApproval,
  type ApprovalBlock,
  type Block,
  type ViewState,
} from "./state.ts";

// What the view asks the page to do. The page sends the line or the answer to the server.
export interface ViewActions {
  line(text: string): void;
  answer(id: number, answer: ApprovalAnswer): void;
}

export interface View {
  render(state: ViewState): void;
}

const LINK_TEXT: Record<ViewState["link"], string> = {
  connecting: "connecting",
  live: "connected",
  lost: "disconnected, retrying",
  taken: "this session was opened in another tab",
  "no-token": "open the link printed in the terminal",
};

// Every piece of text is set with textContent, never as HTML, so model output cannot run as markup.
function element<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function approvalCard(
  doc: Document,
  block: ApprovalBlock,
  actions: ViewActions,
): HTMLElement {
  const card = element(doc, "section", "block approval", "");
  card.append(element(doc, "p", "label", "Approve this change?"));
  card.append(element(doc, "pre", "preview", block.preview));
  if (block.answer !== undefined) {
    card.append(element(doc, "p", "answered", `answered: ${block.answer}`));
    return card;
  }
  const buttons = doc.createElement("div");
  buttons.className = "buttons";
  const choices: [string, ApprovalAnswer][] = [
    ["Approve", "approve"],
    ["Refuse", "refuse"],
    ["End session", "exit"],
  ];
  for (const [label, answer] of choices) {
    const button = element(doc, "button", "choice", label);
    button.dataset.answer = answer;
    button.addEventListener("click", () => actions.answer(block.id, answer));
    buttons.append(button);
  }
  card.append(buttons);
  return card;
}

function blockElement(
  doc: Document,
  block: Block,
  actions: ViewActions,
): HTMLElement {
  switch (block.kind) {
    case "user":
      return element(doc, "div", "block user", block.text);
    case "reply":
      return element(doc, "div", "block reply", block.text);
    case "thinking": {
      const label = block.exact
        ? `thinking: ${block.tokens} tokens`
        : `thinking: ~${block.tokens} tokens`;
      return element(doc, "div", "block thinking", label);
    }
    case "tool":
      return element(
        doc,
        "div",
        block.skipped ? "block tool skipped" : "block tool",
        block.skipped
          ? `${block.description} did not run: the session ended`
          : block.description,
      );
    case "approval":
      return approvalCard(doc, block, actions);
    case "hook": {
      const details = doc.createElement("details");
      details.className = "block hook";
      details.append(element(doc, "summary", "", "hook output"));
      details.append(element(doc, "pre", "", block.text));
      return details;
    }
    case "notice":
      return element(doc, "div", "block notice", block.text);
    case "error":
      return element(doc, "div", "block error", `error: ${block.message}`);
  }
}

// The saved sessions, each a button that loads it. Clicking sends /load <name>, the line the user would
// type, so the page keeps to lines and approvals.
function sessionsPanel(
  doc: Document,
  names: string[],
  enabled: boolean,
  actions: ViewActions,
): HTMLElement[] {
  const heading = element(doc, "span", "label", "Saved sessions");
  if (names.length === 0) {
    return [heading, element(doc, "span", "hint", "none yet: /save <name> keeps the conversation")];
  }
  const buttons = names.map((name) => {
    const button = element(doc, "button", "session", name);
    button.disabled = !enabled;
    button.addEventListener("click", () => actions.line(`/load ${name}`));
    return button;
  });
  return [heading, ...buttons];
}

// Builds the page once, then replaces the transcript and the controls on each render.
export function createView(
  doc: Document,
  root: HTMLElement,
  actions: ViewActions,
): View {
  const header = element(doc, "header", "bar", "Vise");
  const status = element(doc, "span", "status", "");
  header.append(status);
  const panel = doc.createElement("section");
  panel.className = "sessions";
  const transcript = element(doc, "main", "transcript", "");
  const form = doc.createElement("form");
  form.className = "composer";
  const input = doc.createElement("textarea");
  input.rows = 2;
  input.placeholder = "Message Vise (Enter sends, Shift+Enter adds a line)";
  const send = element(doc, "button", "send", "Send");
  send.type = "submit";
  form.append(input, send);
  root.append(header, panel, transcript, form);

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (text === "" || input.disabled) return;
    input.value = "";
    actions.line(text);
  });

  return {
    render(state) {
      const nearBottom =
        transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
      status.textContent = state.ended
        ? `session ended${state.endError ? `: ${state.endError}` : ""}`
        : LINK_TEXT[state.link];
      transcript.replaceChildren(
        ...state.blocks.map((block) => blockElement(doc, block, actions)),
      );
      const open = openApproval(state);
      const sendable = canSend(state);
      panel.replaceChildren(
        ...sessionsPanel(doc, state.sessions, sendable, actions),
      );
      input.disabled = !sendable;
      send.disabled = !sendable;
      input.placeholder = open
        ? "Answer the question above with its buttons"
        : "Message Vise (Enter sends, Shift+Enter adds a line)";
      if (nearBottom) transcript.scrollTop = transcript.scrollHeight;
    },
  };
}
