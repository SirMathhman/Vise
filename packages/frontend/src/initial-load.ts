import type { ListsSnapshot } from "@vise/backend/src/repl/lists.ts";
import type { ResultMessage, ServerMessage } from "./server-message.ts";
import type { Panels } from "./settings/panels.ts";
import type { ProfileEditor } from "./settings/profiles/profile-editor.ts";
import type { BusyState } from "./composer/busy.ts";
import { applyCommandResult } from "./command-results.ts";

/** The slice of the transcript the results write to. */
interface Lines {
  addLine(cls: string, text: string): void;
  clear(): void;
}

interface LoadDeps {
  send(msg: Record<string, unknown>): void;
  panels: Panels;
  transcript: Lines;
  busy: { state: BusyState; render(): void; endLoading(): void };
  setBurstPressed(on: boolean): void;
  profileSelect: HTMLSelectElement;
  /** The saved-session list changed (the Session menu lists them). */
  onSessions(): void;
  /** A `/model` command switched the model: the picker shows it. */
  setActiveModel(id: string): void;
}

/**
 * What the page asks the server for besides the user's lines, and the replies
 * to it: the `lists` the controls show (profiles, tools, reasoning levels,
 * sessions, burst state; the server sends them when asked and again after every
 * line), tool toggles matched by id (they may answer after a running turn's),
 * whitelist reads and writes, and the results of the commands the page itself
 * sends (which update the header and menus).
 */
export function createInitialLoad(deps: LoadDeps) {
  const { send, panels, transcript, busy } = deps;
  // Tool toggles are lines, matched by id: one made while a turn runs answers after the turn,
  // and must be neither taken for the turn's result nor change the busy state.
  const toolToggles = new Set<string>();
  // Whitelist reads/writes bypass the turn queue (`profile_tools` messages).
  const whitelistRequests = new Map<string, { name: string; save: boolean }>();
  let profileEditor: ProfileEditor | null = null;
  let nextRequestId = 0;

  const requestLists = (): void => send({ type: "lists_get" });

  const fail = (message: ResultMessage): void =>
    transcript.addLine("error", message.error ?? "unknown error");

  /** Fill every control from the server's lists; a list the server could not read keeps what it showed. */
  function applyLists(lists: ListsSnapshot): void {
    if (lists.profiles) panels.populateProfileSelect(lists.profiles);
    else if (lists.errors.length > 0) deps.profileSelect.disabled = true;
    if (lists.tools) panels.populateToolsPanel(lists.tools);
    if (lists.reasoning) panels.populateReasoningSelect(lists.reasoning);
    if (lists.sessions) {
      panels.populateSessionsPanel(lists.sessions);
      deps.onSessions();
    }
    deps.setBurstPressed(lists.burst);
    for (const problem of lists.errors) transcript.addLine("error", problem);
    busy.endLoading();
  }

  /** Replies to requests made beside the turn (tool toggles): true when the message was one. */
  function handleSideResult(message: ResultMessage): boolean {
    if (message.id !== undefined && toolToggles.delete(message.id)) {
      if (!message.ok) fail(message);
      else if (!busy.state.server) transcript.addLine("system", message.value ?? "");
      // The server pushes the new tool states with its `lists` after the line.
      return true;
    }
    return false;
  }

  function handleWhitelistReply(message: ServerMessage): void {
    const request = message.id ? whitelistRequests.get(message.id) : undefined;
    if (!request || !message.id) return;
    whitelistRequests.delete(message.id);
    if (message.ok) {
      profileEditor?.showWhitelist(request.name, message.tools ?? undefined);
      if (request.save) profileEditor?.showStatus("Saved.");
    } else {
      profileEditor?.showStatus(`Failed: ${message.error ?? "unknown error"}`, true);
    }
  }

  return {
    setProfileEditor(editor: ProfileEditor): void {
      profileEditor = editor;
    },
    /** Ask for every list (the connection just opened). */
    start(): void {
      busy.state.loading = true;
      busy.render();
      // The model picker has its own list (answered at once), and so do the controls.
      send({ type: "model_list" });
      requestLists();
      // Populate the workflow picker's cache so shortcut invocations show the strip immediately.
      send({ type: "workflows_list" });
    },
    /** The lists changed on the server (a session was saved or deleted): ask again. */
    refreshSessions: requestLists,
    /** A `lists` message: true when it was one. */
    handleLists(message: ServerMessage): boolean {
      if (message.type !== "lists" || !message.lists) return false;
      applyLists(message.lists);
      return true;
    },
    handleSideResult,
    handleCommandResult: (message: ResultMessage, syncBrowser: () => void): void =>
      applyCommandResult(message, { ...deps, syncBrowser }),
    handleWhitelistReply,
    toggleTool(line: string): void {
      const id = `ed${nextRequestId++}`;
      toolToggles.add(id);
      send({ type: "line", text: line, id });
    },
    requestWhitelist(name: string, save: boolean, tools?: string[]): void {
      const id = `ed${nextRequestId++}`;
      whitelistRequests.set(id, { name, save });
      send({ type: "profile_tools", id, name, read: !save, tools: tools ?? null });
    },
    selectValues(select: HTMLSelectElement): string[] {
      return Array.from(select.options)
        .filter((option) => option.value && !option.disabled)
        .map((option) => option.value);
    },
  };
}
