import type { ServerWebSocket } from "bun";
import type { createEdgeSession } from "@vise/backend";
import type { McpHub } from "@vise/backend";
import type { BrowserBridge } from "../ext/browser-bridge.ts";
import type { createInspector } from "../inspect/inspect.ts";
import type { HeldLine } from "../conn/line.ts";
import type { SessionLease } from "../conn/leases.ts";
import type { WebUserPrompter } from "../conn/prompter.ts";
import type { TerminalAttachment } from "../terminal/terminal-registry.ts";
import type { WebDisplay, WsData } from "../server.ts";

/** Everything one page's WebSocket connection owns (a connection is one conversation). */
export interface ConnectionState {
  ws: ServerWebSocket<WsData>;
  send: (msg: Record<string, unknown>) => void;
  prompter: WebUserPrompter;
  display: WebDisplay;
  session: ReturnType<typeof createEdgeSession>["session"];
  edge: ReturnType<typeof createEdgeSession>;
  chain: Promise<void>;
  held: HeldLine[];
  running: boolean;
  /** Stop paused what is lined up (see `stopLine`). */
  paused?: boolean;
  bridge: BrowserBridge;
  /** The folder's MCP servers (shared by its pages). */
  mcp?: McpHub;
  /** Stops the project-tree watcher; set once the connection opens. */
  unwatch: () => void;
  /** The session's data directory (its notes live there). */
  dataDir: string;
  /** The saved sessions this connection works in (one connection at a time per session). */
  lease: SessionLease;
  /** This page's handle on its folder's shell; null with no folder or in the extension's sidebar. */
  terminal: TerminalAttachment | null;
  /** Push the page's lists again (after a line: a command may have changed them). */
  lists: () => Promise<void>;
  /** The page's live look at model calls (made when it first asks). */
  inspector?: ReturnType<typeof createInspector>;
}

/** A message from the page: its `type` and the few fields the routes below read (the rest are read by the handler that owns the type). */
export interface WireMessage {
  type: string;
  /** `inspect_start`: the model call to watch (the running one when absent). */
  request?: number;
  text?: string;
  id?: string;
  name?: string;
  /** `profile_tools` write: the whitelist, or null for all tools. */
  tools?: string[] | null;
  /** `profile_tools`: read the current whitelist instead of writing one. */
  read?: boolean;
  /** `line`: pictures attached to the message (data URIs; checked by `acceptPictures`). */
  images?: unknown;
  /** `line`: the page's id for a message held until the work in flight is done; `unqueue`: the one to remove. */
  qid?: string;
  /** `env_set`: the settings page's values by variable name. */
  values?: Record<string, string>;
}
