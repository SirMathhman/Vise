import { type ModelPorts, type ReplyRequest, type ToolCall, type Result } from "../core/messages.ts";

import { type HookPoint, type ProfileHook, type ProfileStore } from "../core/notes.ts";


import type { ResumeStore, SessionStore } from "../core/sessions.ts";

import type { Approve } from "../core/tools.ts";

// Every port the session uses. All are required; a caller that omits one fails to compile.
export interface SessionPorts {
  reply(request: ReplyRequest): AsyncIterable<Result<string>>;
  contextWindow(): Promise<Result<number>>;
  tools(call: ToolCall, approve: Approve, offered: string[]): Promise<string>;
  notes(words: string[]): Promise<string>;
  profile(name: string): Promise<Result<string>>;
  // The tools a profile allows, undefined when it has no whitelist.
  profileTools(name: string): Promise<Result<string[] | undefined>>;
  // The hooks a profile adds at its points.
  profileHooks(name: string): Promise<Result<ProfileHook[]>>;
  // Runs the hooks of one point. Their output goes to the next message.
  hooks(point: HookPoint, profile?: string[]): Promise<Result<string>>;
  // Every tool the session may offer: the built-in tools and those of the MCP servers that started.
  allTools: string[];
  // The tools switched off when the session starts, and the writer for the settings file.
  disabledTools: string[];
  saveDisabledTools(names: string[]): Promise<Result<void>>;
  // Where /save and /load keep sessions.
  sessions: SessionStore;
  // Where the conversation is kept for the next run. Absent, nothing is resumed.
  resume?: ResumeStore;
  // Where the page reads and saves profiles. Absent, the page has no profile editor.
  profiles?: ProfileStore;
  // The model in use, and the models /model may switch to.
  models: ModelPorts;
  // Text sent ahead of the first message of the session (the AGENTS.md file), if any.
  instructions?: string;
}
