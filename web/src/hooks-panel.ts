/** Id the `/hooks` edit lines carry, so their results are told apart from the model's turns. */
const EDIT_ID = "hooks-edit";

type Phase = "pre" | "post";

/** One hook and the profiles it is bound to (it runs only with those; unbound hooks always run). */
interface HookLine {
  command: string;
  profiles: string[];
}

/** The fields of a server `hooks` message. */
export interface HooksFields {
  pre?: HookLine[];
  post?: HookLine[];
  profiles?: string[];
}

interface HooksMessage extends HooksFields {
  type: string;
  id?: string;
  ok?: boolean;
  error?: string;
}

/** Sends a `/hooks ...` line to the server. */
type Edit = (line: string) => void;

const PHASES: { phase: Phase; label: string }[] = [
  { phase: "pre", label: "pre-turn hooks (output injected before every turn)" },
  {
    phase: "post",
    label: "post-turn hooks (output injected after every turn)",
  },
];

/**
 * The hooks panel: lists the pre- and post-turn hook commands and lets the
 * user add, remove and bind them to profiles. The server owns the lists
 * (`hooks` messages carry them with each hook's bindings); edits go back as
 * `/hooks ...` lines, so they take effect at once and are saved just like the
 * terminal commands (hooks in `.viserc.json`, bindings in the profile files).
 */
export function createHooksPanel(
  button: HTMLButtonElement,
  panel: HTMLElement,
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
): { handle(message: HooksMessage): boolean } {
  const status = document.createElement("div");
  status.className = "pe-status";
  status.setAttribute("role", "status");
  let lists: Record<Phase, HookLine[]> = { pre: [], post: [] };
  let profiles: string[] = [];

  const edit = (line: string): void => {
    status.textContent = "";
    send({ type: "line", text: line, id: EDIT_ID });
  };

  function render(): void {
    body.textContent = "";
    for (const { phase, label } of PHASES) {
      const heading = document.createElement("div");
      heading.className = "files-path";
      heading.textContent = label;
      body.appendChild(heading);
      const list = document.createElement("ul");
      list.className = "tools-list";
      const hooks = lists[phase];
      if (hooks.length === 0) {
        list.appendChild(document.createElement("li")).textContent = "none";
      }
      hooks.forEach((hook, i) => {
        const item = document.createElement("li");
        item.className = "session-row"; // reveals the × on hover
        const text = document.createElement("code");
        text.textContent = `${i + 1}. ${hook.command}`;
        const remove = document.createElement("button");
        remove.className = "session-delete";
        remove.textContent = "×";
        remove.title = `remove hook ${i + 1}`;
        remove.addEventListener("click", () =>
          edit(`/hooks remove ${phase} ${i + 1}`),
        );
        item.append(text, bindings(phase, i + 1, hook, profiles, edit), remove);
        list.appendChild(item);
      });
      body.append(list, addRow(phase, edit));
    }
    body.appendChild(status);
  }

  button.addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) send({ type: "hooks_get" });
  });

  return {
    handle(message) {
      if (message.type === "hooks") {
        lists = { pre: message.pre ?? [], post: message.post ?? [] };
        profiles = message.profiles ?? [];
        render();
        return true;
      }
      if (message.type === "result" && message.id === EDIT_ID) {
        if (!message.ok) status.textContent = message.error ?? "edit failed";
        send({ type: "hooks_get" });
        return true;
      }
      return false;
    },
  };
}

function addRow(phase: Phase, edit: Edit): HTMLElement {
  const row = document.createElement("div");
  row.className = "save-row";
  const input = document.createElement("input");
  input.className = "save-input";
  input.type = "text";
  input.placeholder = `add a ${phase}-turn hook command…`;
  input.autocomplete = "off";
  const add = document.createElement("button");
  add.className = "save-btn";
  add.textContent = "add";
  const submit = (): void => {
    const command = input.value.trim();
    if (!command) return;
    // The terminal form quotes the command; escape any quotes inside it.
    edit(`/hooks add ${phase} "${command.replaceAll('"', '\\"')}"`);
    input.value = "";
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  row.append(input, add);
  return row;
}

/** A chip per bound profile (click to unbind) and a picker to bind another. */
function bindings(
  phase: Phase,
  n: number,
  hook: HookLine,
  profiles: string[],
  edit: Edit,
): HTMLElement {
  const box = document.createElement("span");
  box.className = "hook-bindings";
  for (const profile of hook.profiles) {
    const chip = document.createElement("button");
    chip.className = "hook-chip";
    chip.textContent = `${profile} ×`;
    chip.title = `unbind from ${profile}`;
    chip.addEventListener("click", () =>
      edit(`/hooks unbind ${phase} ${n} ${profile}`),
    );
    box.appendChild(chip);
  }
  const free = profiles.filter((p) => !hook.profiles.includes(p));
  if (free.length > 0) {
    const pick = document.createElement("select");
    pick.className = "model";
    pick.title =
      "Run this hook only with the chosen profile(s); unbound hooks always run";
    pick.add(new Option("bind to profile…", ""));
    for (const profile of free) pick.add(new Option(profile, profile));
    pick.addEventListener("change", () => {
      if (pick.value) edit(`/hooks bind ${phase} ${n} ${pick.value}`);
    });
    box.appendChild(pick);
  }
  return box;
}
