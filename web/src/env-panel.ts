/** One setting as the server describes it (`env` message; see `src/settings-file.ts`). */
interface EnvField {
  env: string;
  group: string;
  label: string;
  kind: "text" | "number";
  def: string | number;
  min?: number;
  value: string;
  secret: boolean;
  set: boolean;
  restart: boolean;
}

export interface EnvMessage {
  type: string;
  path?: string;
  fields?: EnvField[];
  saved?: boolean;
  error?: string;
}

/**
 * The "general" settings tab: every setting from the user-level settings file
 * (`~/.vise/.env`) in groups, with its default as the placeholder. An empty
 * box means the default. Saving applies the values at once; the few that are
 * read only at start-up are marked. A secret is never sent back to the page:
 * leaving its box empty keeps the saved one.
 */
export function createEnvPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  openers: HTMLElement[],
): { handle(message: EnvMessage): boolean } {
  const inputs = new Map<string, HTMLInputElement>();
  const status = document.createElement("div");
  status.className = "pe-status";
  status.setAttribute("role", "status");
  const where = document.createElement("div");
  where.className = "setting-hint";

  function render(fields: EnvField[]): void {
    inputs.clear();
    body.textContent = "";
    body.append(where);
    let group = "";
    let box: HTMLElement = body;
    for (const field of fields) {
      if (field.group !== group) {
        group = field.group;
        const heading = document.createElement("h4");
        heading.className = "setting-group";
        heading.textContent = group;
        box = document.createElement("div");
        body.append(heading, box);
      }
      const row = document.createElement("label");
      row.className = "setting-row";
      const name = document.createElement("span");
      name.textContent = field.restart ? `${field.label} (after restart)` : field.label;
      const input = document.createElement("input");
      input.className = "save-input";
      input.autocomplete = "off";
      if (field.secret) {
        input.type = "password";
        input.placeholder = field.set ? "saved (type to replace)" : "not set";
      } else {
        input.type = field.kind === "number" ? "number" : "text";
        if (field.kind === "number") {
          input.step = "any";
          if (field.min !== undefined) input.min = String(field.min);
        }
        input.placeholder = `default: ${field.def}`;
        input.value = field.value;
      }
      input.title = field.env;
      inputs.set(field.env, input);
      row.append(name, input);
      box.append(row);
    }
    const save = document.createElement("button");
    save.className = "save-btn";
    save.textContent = "save";
    save.addEventListener("click", () => {
      const values: Record<string, string> = {};
      for (const [env, input] of inputs) values[env] = input.value;
      status.textContent = "saving…";
      send({ type: "env_set", values });
    });
    const row = document.createElement("div");
    row.className = "save-row";
    row.append(save, status);
    body.append(row);
  }

  for (const opener of openers) {
    opener.addEventListener("click", () => send({ type: "env_get" }));
  }
  send({ type: "env_get" });

  return {
    handle(message) {
      if (message.type !== "env") return false;
      // A refused save keeps what was typed, so it can be corrected.
      if (message.error) {
        status.textContent = `not saved: ${message.error}`;
        return true;
      }
      where.textContent = `Saved to ${message.path ?? ""}. Changes apply at once. Empty means the default.`;
      render(message.fields ?? []);
      status.textContent = message.saved ? "saved ✓" : "";
      return true;
    },
  };
}
