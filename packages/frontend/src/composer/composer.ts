import { COMMANDS } from "../../../backend/src/repl/command-catalog.ts";
import { getArgumentSuggestions } from "./command-completions.ts";
import type { CommandSuggestion } from "./command-completions.ts";

export interface ComposerChoices {
  models: string[];
  profiles: string[];
  sessions: { id: string; name: string }[];
  tools: string[];
}

interface ComposerState {
  visible: CommandSuggestion[];
  active: number;
}

const slashCommands: [string, string, boolean][] = COMMANDS.map((c) => [
  c.name,
  c.summary,
  c.takesArgs,
]);

export function setupComposer(
  input: HTMLTextAreaElement,
  suggestions: HTMLUListElement,
  choices: () => ComposerChoices,
  sendLine: (text: string, queue?: boolean) => void,
): () => void {
  const state: ComposerState = { visible: [], active: 0 };

  function hideSuggestions(): void {
    hideComposerSuggestions(state, input, suggestions);
  }

  function acceptSuggestion(index = state.active): void {
    const suggestion = state.visible[index];
    if (!suggestion) return;
    input.value = `${suggestion.value}${suggestion.appendSpace ? " " : ""}`;
    hideSuggestions();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function argumentSuggestions(value: string): CommandSuggestion[] {
    const match = value.match(/^(\/\w+)\s+(.*)$/);
    if (!match) return [];
    const [, command, rawArgs] = match;
    const available = choices();
    return getArgumentSuggestions(command, rawArgs, {
      models: available.models.map((name) => ({ label: name, value: name })),
      profiles: available.profiles.map((name) => ({
        label: name,
        value: name,
      })),
      sessions: available.sessions.map(({ id, name }) => ({
        label: name,
        value: id,
        description: id.slice(0, 8),
      })),
      tools: available.tools.map((name) => ({ label: name, value: name })),
    });
  }

  function renderSuggestions(): void {
    const value = input.value;
    if (!value.startsWith("/")) {
      hideSuggestions();
      return;
    }

    const matches = /\s/.test(value)
      ? argumentSuggestions(value)
      : slashCommands
          .filter(
            ([command]) =>
              command.startsWith(value.toLowerCase()) && command !== value.toLowerCase(),
          )
          .map(([command, description, takesArguments]) => ({
            label: command,
            description,
            value: command,
            appendSpace: takesArguments,
          }));
    if (matches.length === 0) {
      hideSuggestions();
      return;
    }

    state.visible = matches.slice(0, 8);
    state.active = 0;
    renderSuggestionButtons(suggestions, state.visible, acceptSuggestion);
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", "command-suggestion-0");
  }

  function moveSuggestion(direction: number): void {
    moveActiveSuggestion(state, input, suggestions, direction);
  }

  const recall = createRecall();
  input.addEventListener("input", () => {
    fitHeight(input);
    renderSuggestions();
  });
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (state.visible.length === 0 && recallKey(event, input, recall)) return;
    handleComposerKey(
      event,
      state,
      input,
      (text, queue) => {
        recall.push(text);
        sendLine(text, queue);
      },
      acceptSuggestion,
      moveSuggestion,
      hideSuggestions,
    );
  });

  return hideSuggestions;
}

function handleComposerKey(
  event: KeyboardEvent,
  state: ComposerState,
  input: HTMLTextAreaElement,
  sendLine: (text: string, queue?: boolean) => void,
  acceptSuggestion: () => void,
  moveSuggestion: (direction: number) => void,
  hideSuggestions: () => void,
): void {
  if (state.visible.length > 0) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSuggestion(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSuggestion(-1);
      return;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      acceptSuggestion();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hideSuggestions();
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    // Ctrl/Cmd+Enter holds the message back while the agent works (it steers otherwise).
    sendLine(input.value, event.ctrlKey || event.metaKey);
    clearComposer(input);
  }
}

/** The tallest the message box grows before it scrolls, as a share of the window. */
const MAX_HEIGHT_SHARE = 0.4;

/** Grow (or shrink) the message box to its text, up to a share of the window. */
function fitHeight(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  const max = Math.round(window.innerHeight * MAX_HEIGHT_SHARE);
  input.style.height = `${Math.min(input.scrollHeight + 2, max)}px`;
  input.style.overflowY = input.scrollHeight + 2 > max ? "auto" : "hidden";
}

/** Empty the message box (after a send) and shrink it back to one line. */
export function clearComposer(input: HTMLTextAreaElement): void {
  input.value = "";
  fitHeight(input);
}

/** The messages sent from this page, newest last, and where ↑/↓ have walked to. */
interface Recall {
  push(text: string): void;
  older(): string | undefined;
  newer(): string | undefined;
  walking(): boolean;
}

/** Most messages ↑ can bring back. */
const RECALL_SIZE = 50;

function createRecall(): Recall {
  const sent: string[] = [];
  let at = -1;
  return {
    push(text) {
      at = -1;
      const body = text.trim();
      if (!body || sent.at(-1) === body) return;
      sent.push(body);
      if (sent.length > RECALL_SIZE) sent.shift();
    },
    older() {
      if (sent.length === 0) return undefined;
      at = at < 0 ? sent.length - 1 : Math.max(0, at - 1);
      return sent[at];
    },
    newer() {
      if (at < 0) return undefined;
      at += 1;
      if (at >= sent.length) {
        at = -1;
        return "";
      }
      return sent[at];
    },
    walking: () => at >= 0,
  };
}

/**
 * ↑ in an empty box (or on a recalled message) brings back the previous
 * message sent from this page, ↓ the next; true when the key was used.
 */
function recallKey(event: KeyboardEvent, input: HTMLTextAreaElement, recall: Recall): boolean {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  const usable = input.value === "" || recall.walking();
  if (!usable) return false;
  const text =
    event.key === "ArrowUp"
      ? recall.older()
      : event.key === "ArrowDown"
        ? recall.newer()
        : undefined;
  if (text === undefined) return false;
  event.preventDefault();
  input.value = text;
  fitHeight(input);
  input.setSelectionRange(text.length, text.length);
  return true;
}

function hideComposerSuggestions(
  state: ComposerState,
  input: HTMLTextAreaElement,
  suggestions: HTMLUListElement,
): void {
  state.visible = [];
  state.active = 0;
  suggestions.textContent = "";
  suggestions.classList.add("hidden");
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function moveActiveSuggestion(
  state: ComposerState,
  input: HTMLTextAreaElement,
  suggestions: HTMLUListElement,
  direction: number,
): void {
  if (state.visible.length === 0) return;
  state.active = (state.active + direction + state.visible.length) % state.visible.length;
  suggestions.querySelectorAll(".command-suggestion").forEach((button, index) => {
    const active = index === state.active;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  input.setAttribute("aria-activedescendant", `command-suggestion-${state.active}`);
}

function renderSuggestionButtons(
  list: HTMLUListElement,
  candidates: CommandSuggestion[],
  accept: (index: number) => void,
): void {
  list.textContent = "";
  candidates.forEach(({ label, description }, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.id = `command-suggestion-${index}`;
    button.className = `command-suggestion${index === 0 ? " active" : ""}`;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === 0));
    const name = document.createElement("span");
    name.className = "command-suggestion-name";
    name.textContent = label;
    const detail = document.createElement("span");
    detail.className = "command-suggestion-description";
    detail.textContent = description;
    button.append(name, detail);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => accept(index));
    list.appendChild(button);
  });
  list.classList.remove("hidden");
}
