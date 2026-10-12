import type { HookStore } from "../../edge-sources.ts";
import type { McpHub } from "../../mcp/mcp-hub.ts";
import { mcpNote } from "../../output/mcp-format.ts";
import { config } from "../../config.ts";
import type { SemanticIndexPort } from "../../repl/ports.ts";
import { watchRoot } from "../api/files.ts";
import type { TerminalAttachment, TerminalRegistry } from "../terminal/terminal-registry.ts";
import { queueAutoResume, type ResumeConnection } from "./resume.ts";

/** What finishing a page's connection needs from it. */
export interface OpeningConnection extends ResumeConnection {
  send: (msg: Record<string, unknown>) => void;
  bridge: { handle(msg: Record<string, unknown>): Promise<unknown> };
  unwatch: () => void;
  terminal: TerminalAttachment | null;
}

export interface OpeningContext {
  root: string;
  noFolder: boolean;
  sidebar: boolean;
  /** The first messages: where the page is rooted. */
  rootMessage: Record<string, unknown>;
  hookStore: HookStore;
  hub: McpHub;
  terminals: TerminalRegistry;
  /** Give the folder back when the connection closes. */
  releaseRoot: () => void;
  /** Refresh the page's hooks panel. */
  pushHooks: () => void;
  /** The folder's semantic index: its status is pushed to the page, and it follows the files. */
  semantic?: SemanticIndexPort;
  /** Shown in the page after the restored conversation (e.g. that the wanted port was busy). */
  note?: string;
}

/** Show `note` in the page after the restored conversation, which replaces the chat log. */
function queueNote(conn: OpeningConnection, note: string | undefined): void {
  if (!note) return;
  conn.chain = conn.chain.then(() => conn.send({ type: "notice", text: note }));
}

/** The first messages, watchers and shell of a page whose connection was just built. */
export function finishOpening(
  conn: OpeningConnection,
  c: OpeningContext,
): void {
  conn.send(c.rootMessage);
  conn.send({ type: "goal_state", enabled: conn.session.goalChecking() });
  // The shared browser's engine setting, for the settings panel.
  void conn.bridge.handle({ type: "browser_settings_get" });
  // Tell the browser's file explorer whenever the project tree changes.
  // Any connection's hook edit refreshes every open hooks panel.
  const offHooks = c.hookStore.onChange(c.pushHooks);
  // Files that changed are re-embedded a moment after the last change.
  let reindex: ReturnType<typeof setTimeout> | undefined;
  const filesChanged = (): void => {
    conn.send({ type: "fs_changed" });
    if (!c.semantic || config.semanticAutoIndex === 0) return;
    clearTimeout(reindex);
    reindex = setTimeout(() => void c.semantic?.update(), 3000);
  };
  const stopWatching = c.noFolder ? () => {} : watchRoot(c.root, filesChanged);
  const pushSemantic = (): void => conn.send({ type: "sem_status", status: c.semantic?.status() ?? null });
  const offSemantic = c.semantic?.onChange(pushSemantic);
  pushSemantic();
  conn.unwatch = () => {
    stopWatching();
    clearTimeout(reindex);
    offSemantic?.();
    offHooks();
    c.releaseRoot();
  };
  // One shell per folder, shared by its pages and kept across reloads.
  if (!c.noFolder && !c.sidebar) {
    conn.terminal = c.terminals.attach(c.root, conn.send);
  }
  queueAutoResume(conn);
  queueNote(conn, [c.note, mcpNote(c.hub)].filter(Boolean).join("\n") || undefined);
}
