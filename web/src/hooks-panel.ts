/** Id the `/hooks add|remove` lines carry, so their results are told apart from the model's turns. */
const EDIT_ID = "hooks-edit";

type Phase = "pre" | "post";

interface HooksMessage {
  type: string;
  id?: string;
  ok?: boolean;
  error?: string;
  pre?: string[];
  post?: string[];
}

const PHASES: { phase: Phase; label: string }[] = [
  { phase: "pre", label: "pre-turn hooks (output injected before every turn)" },
  {
    phase: "post",
    label: "post-turn hooks (output injected after every turn)",
  },
];

/**
 * The hooks panel: lists the pre- and post-turn hook commands and lets the
 * user add or remove them. The server owns the lists (`hooks` messages carry
 * them); edits go back as `/hooks add|remove` lines, so they take effect at
 * once and are saved to `.viserc.json` just like the terminal command.
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
  let lists: Record<Phase, string[]> = { pre: [], post: [] };

  const edit = (line: string): void => {
    status.textContent = "";
    send({ type: "line", text: line, id: EDIT_ID });
  };

  function addRow(phase: Phase): HTMLElement {
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

  function render(): void {
    body.textContent = "";
    for (const { phase, label } of PHASES) {
      const heading = document.createElement("div");
      heading.className = "files-path";
      heading.textContent = label;
      body.appendChild(heading);
      const list = document.createElement("ul");
      list.className = "tools-list";
      const commands = lists[phase];
      if (commands.length === 0) {
        list.appendChild(document.createElement("li")).textContent = "none";
      }
      commands.forEach((command, i) => {
        const item = document.createElement("li");
        item.className = "session-row"; // reveals the × on hover
        const text = document.createElement("code");
        text.textContent = `${i + 1}. ${command}`;
        const remove = document.createElement("button");
        remove.className = "session-delete";
        remove.textContent = "×";
        remove.title = `remove hook ${i + 1}`;
        remove.addEventListener("click", () =>
          edit(`/hooks remove ${phase} ${i + 1}`),
        );
        item.append(text, remove);
        list.appendChild(item);
      });
      body.append(list, addRow(phase));
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
