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

const slashCommands: [string, string, boolean][] = [
  ["/exit", "exit the REPL", false],
  ["/help", "show available commands", false],
  ["/context", "show context window usage", false],
  ["/compact", "compact the conversation", false],
  ["/model", "list or switch models", true],
  ["/reasoning", "list or set reasoning effort", true],
  ["/new", "start a new conversation", false],
  ["/burst", "toggle plan-then-act burst mode", true],
  ["/tool", "list or toggle tools", true],
  ["/profile", "list, switch, or create profiles", true],
  ["/note", "list or create notes", true],
  ["/workflow", "list, run, or create workflows", true],
  ["/save", "list or save sessions", true],
  ["/resume", "list or resume sessions", true],
  ["/delete", "delete a saved session", true],
];

export function setupComposer(
  input: HTMLInputElement,
  suggestions: HTMLUListElement,
  choices: () => ComposerChoices,
  sendLine: (text: string) => void,
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
              command.startsWith(value.toLowerCase()) &&
              command !== value.toLowerCase(),
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

  input.addEventListener("input", renderSuggestions);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    handleComposerKey(
      event,
      state,
      input,
      sendLine,
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
  input: HTMLInputElement,
  sendLine: (text: string) => void,
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
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendLine(input.value);
    input.value = "";
  }
}

function hideComposerSuggestions(
  state: ComposerState,
  input: HTMLInputElement,
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
  input: HTMLInputElement,
  suggestions: HTMLUListElement,
  direction: number,
): void {
  if (state.visible.length === 0) return;
  state.active =
    (state.active + direction + state.visible.length) % state.visible.length;
  suggestions
    .querySelectorAll(".command-suggestion")
    .forEach((button, index) => {
      const active = index === state.active;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
  input.setAttribute(
    "aria-activedescendant",
    `command-suggestion-${state.active}`,
  );
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
