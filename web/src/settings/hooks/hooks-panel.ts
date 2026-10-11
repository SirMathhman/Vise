import { type HookCommands, renderHookLists } from "./hook-lists.ts";

/** Id the `/hooks` edit lines carry, so their results are told apart from the model's turns. */
const EDIT_ID = "hooks-edit";

/** The fields of a server `hooks` message: the global hooks and the hooks each profile owns. */
export interface HooksFields {
  pre?: string[];
  post?: string[];
  profiles?: string[];
  profileHooks?: Record<string, HookCommands>;
}

interface HooksMessage extends HooksFields {
  type: string;
  id?: string;
  ok?: boolean;
  error?: string;
}

const LABELS = {
  pre: "Pre-turn hooks · output added before every turn, with any profile",
  post: "Post-turn hooks · output added after every turn, with any profile",
};

/**
 * The hooks panel: lists the global pre- and post-turn hook commands (they run
 * regardless of profile) and lets the user add or remove them. Hooks that
 * belong to one profile are edited in the profile editor. The server owns the
 * lists (`hooks` messages carry them); edits go back as `/hooks ...` lines, so
 * they take effect at once and are saved just like the terminal commands.
 */
export function createHooksPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  /** Told about each fresh hooks listing (other views of the hooks refresh from it). */
  onUpdate: (hooks: HooksFields) => void,
): {
  handle(message: HooksMessage): boolean;
  refresh(): void;
  edit(line: string): void;
} {
  const status = document.createElement("div");
  status.className = "status-line";
  status.setAttribute("role", "status");

  const edit = (line: string): void => {
    status.textContent = "";
    send({ type: "line", text: line, id: EDIT_ID });
  };

  return {
    /** Ask the server for the current hooks (the panel just opened). */
    refresh: () => send({ type: "hooks_get" }),
    edit,
    handle(message) {
      if (message.type === "hooks") {
        body.textContent = "";
        const global = { pre: message.pre ?? [], post: message.post ?? [] };
        renderHookLists(body, global, "/hooks", LABELS, edit);
        body.appendChild(status);
        onUpdate(message);
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
