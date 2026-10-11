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
  reasoningSelect: HTMLSelectElement;
  /** The saved-session list changed (the Session menu lists them). */
  onSessions(): void;
}

/** The startup lists, asked for one after another: each reply asks for the next. */
type Step = "model" | "profile" | "tool" | "reasoning" | "sessions" | "burst";

/** One step of the startup chain: true when the reply was its. */
function step(pending: Set<Step>, name: Step, message: ResultMessage, next: () => void, onFail: () => void): boolean {
  if (!pending.has(name)) return false;
  pending.delete(name);
  if (message.ok && message.value !== undefined) next();
  else onFail();
  return true;
}

/** A reply to one of the startup lists: fill its control and ask for the next list; false when it was not one. */
function startupReply(
  message: ResultMessage,
  pending: Set<Step>,
  deps: LoadDeps & { requestLine(text: string): void; fail(): void },
): boolean {
  const { panels, busy, profileSelect, reasoningSelect, requestLine, fail } = deps;
  const value = message.value ?? "";
  const stop = (): void => {
    pending.clear();
    busy.endLoading();
  };
  const afterSessions = (): void => {
    pending.add("burst");
    requestLine("/burst");
  };
  const at = (name: Step, next: () => void, onFail: () => void): boolean =>
    step(pending, name, message, next, onFail);
  return (
    // The session may already have burst on (e.g. after a page reload).
    at("burst", () => {
      deps.setBurstPressed(value.endsWith(" on"));
      busy.endLoading();
    }, () => busy.endLoading()) ||
    at("model", () => {
      panels.populateModelSelect(value);
      requestLine("/profile");
    }, () => {
      stop();
      profileSelect.disabled = true;
      fail();
    }) ||
    at("profile", () => {
      panels.populateProfileSelect(value);
      requestLine("/tool");
    }, () => {
      stop();
      fail();
    }) ||
    at("tool", () => {
      panels.populateToolsPanel(value);
      requestLine("/reasoning");
    }, stop) ||
    at("reasoning", () => {
      panels.populateReasoningSelect(value);
      requestLine("/resume");
    }, () => {
      stop();
      reasoningSelect.disabled = true;
      fail();
    }) ||
    at("sessions", () => {
      panels.populateSessionsPanel(value);
      deps.onSessions();
      afterSessions();
    }, afterSessions)
  );
}

/**
 * What the page asks the server for besides the user's lines, and the replies
 * to it: the lists it loads at start (models, profiles, tools, reasoning
 * levels, sessions, burst state, each a line whose reply asks for the next),
 * refreshes and tool toggles matched by id (they may answer after a running
 * turn's), whitelist reads and writes, and the results of the commands the
 * page itself sends (which update the header and menus).
 */
export function createInitialLoad(deps: LoadDeps) {
  const { send, panels, transcript, busy } = deps;
  const pending = new Set<Step>();
  // The tools refresh is a queued line; its reply is matched by id because the connection also carries the model's turns.
  const toolRefreshes = new Set<string>();
  // Tool toggles are lines too, matched by id: one made while a turn runs answers after the turn,
  // and must be neither taken for the turn's result nor change the busy state.
  const toolToggles = new Set<string>();
  // Whitelist reads/writes bypass the turn queue (`profile_tools` messages).
  const whitelistRequests = new Map<string, { name: string; save: boolean }>();
  let profileEditor: ProfileEditor | null = null;
  let nextRequestId = 0;
  const requestLine = (text: string): void => send({ type: "line", text });

  /** Send a line whose reply is matched by id (it may arrive after a running turn's). */
  function requestTracked(text: string, ids: Set<string>): void {
    const id = `ed${nextRequestId++}`;
    ids.add(id);
    send({ type: "line", text, id });
  }
  const requestToolRefresh = (): void => requestTracked("/tool", toolRefreshes);

  const fail = (message: ResultMessage): void =>
    transcript.addLine("error", message.error ?? "unknown error");

  const handleInitialResult = (message: ResultMessage): boolean =>
    startupReply(message, pending, { ...deps, requestLine, fail: () => fail(message) });

  /** Replies to requests made beside the turn (refreshes, toggles): true when the message was one. */
  function handleSideResult(message: ResultMessage): boolean {
    if (message.id !== undefined && toolRefreshes.delete(message.id)) {
      if (message.ok && message.value) panels.populateToolsPanel(message.value);
      return true;
    }
    if (message.id !== undefined && toolToggles.delete(message.id)) {
      if (!message.ok) fail(message);
      else if (!busy.state.server) transcript.addLine("system", message.value ?? "");
      requestToolRefresh();
      return true;
    }
    return false;
  }

  /** The list of sessions changed on the server: ask for it again (it answers through the startup chain's last steps). */
  function refreshSessions(): void {
    pending.add("sessions");
    busy.state.loading = true;
    busy.render();
    requestLine("/resume");
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
    /** Ask for every list, in order (the connection just opened). */
    start(): void {
      for (const name of ["model", "profile", "tool", "reasoning", "sessions"] as const) pending.add(name);
      busy.state.loading = true;
      busy.render();
      requestLine("/model");
      // Populate the workflow picker's cache so shortcut invocations show the strip immediately.
      send({ type: "workflows_list" });
    },
    refreshSessions,
    handleInitialResult,
    handleSideResult,
    handleCommandResult: (message: ResultMessage, syncBrowser: () => void): void =>
      applyCommandResult(message, { ...deps, syncBrowser, requestToolRefresh, refreshSessions }),
    handleWhitelistReply,
    toggleTool: (line: string): void => requestTracked(line, toolToggles),
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
