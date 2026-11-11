// The contract between the frontend and the backend. Every message is plain data (no functions, no
// class instances), so each one could cross a pipe or a socket later without change.

import type { ApprovalAnswer } from "../core/commands.ts";
import type { HistoryMessage } from "../core/sessions.ts";
import type { ToolSwitch } from "../core/tools.ts";
import type { ProfileDetail, ProfileSummary } from "../core/notes.ts";
import type { McpServerEntry, McpServerStatus, ModelInfo, ProviderEntry, ProviderInput, Scope, ScopedMcpServer, TreeEntry } from "../core/messages.ts";

export type { ApprovalAnswer, HistoryMessage, ToolSwitch, ProfileDetail, ProfileSummary, McpServerEntry, McpServerStatus, Scope, ScopedMcpServer, TreeEntry, ProviderEntry, ProviderInput, ModelInfo };

// A line the user typed. While an approval question is open, the line is its answer: the backend
// reads it as the answer (see answerOfLine). A browser also sends `shown`, the id of the newest question
// its page has displayed. While a question is open, a line answers it only when `shown` is that
// question's id; otherwise the line was typed before the user could see the question, and it is dropped.
// A line without `shown` (the terminal) answers as before.
export interface LineMessage {
  kind: "line";
  text: string;
  shown?: number;
}

// The answer to the approvalRequest with the same id, for a frontend that answers by id rather than
// by typing a line.
export interface ApprovalMessage {
  kind: "approval";
  id: number;
  answer: ApprovalAnswer;
}

// The input has ended: no more lines will arrive.
export interface InputEndedMessage {
  kind: "inputEnded";
}

// The frontend's stream failed (input or output). The session ends with this failure.
export interface FailedMessage {
  kind: "failed";
  message: string;
}

// The page asks for a profile's detail, to edit it.
export interface ProfileReadMessage {
  kind: "profileRead";
  name: string;
}

// The page saves an edited profile. The store writes it only if the profile exists and the detail is valid.
export interface ProfileWriteMessage {
  kind: "profileWrite";
  profile: ProfileDetail;
}

// The page asks for the session to move to another folder. The session restarts there.
export interface FolderChangeMessage {
  kind: "folderChange";
  path: string;
}

// The page asks for the folder dialog on this machine. A folder picked is switched to at once.
export interface PickFolderMessage {
  kind: "pickFolder";
}

// The page answers an ask question: the choices picked by position, and a line typed of its own.
export interface AnswerMessage {
  kind: "answer";
  id: number;
  chosen: number[];
  text: string;
}

// The page saves the MCP servers it shows. The store writes the file only if every entry is valid.
export interface McpWriteMessage {
  kind: "mcpWrite";
  servers: ScopedMcpServer[];
}

// The page asks for the entries of one folder of its file tree. `path` is relative to the working directory;
// the empty path is the working directory itself.
export interface TreeReadMessage {
  kind: "treeRead";
  path: string;
}

// The page asks for the text of one file, to show it in its viewer. `path` is relative to the working directory.
export interface FileReadMessage {
  kind: "fileRead";
  path: string;
}

// The page saves the text of a file it edits. The session writes it, and answers with the file's new text.
export interface FileWriteMessage {
  kind: "fileWrite";
  path: string;
  text: string;
  // The version of the text the edit is based on. The session refuses a save without one.
  base?: string;
}

// The page closes one of the files it has open. The session drops it from the set it keeps.
export interface FileCloseMessage {
  kind: "fileClose";
  path: string;
}

// The page saves the llama.cpp servers it shows. The store writes the file only if every entry is valid.
export interface ProvidersWriteMessage {
  kind: "providersWrite";
  servers: ProviderInput[];
}

export type ClientMessage =
  | LineMessage
  | ApprovalMessage
  | InputEndedMessage
  | FailedMessage
  | ProfileReadMessage
  | ProfileWriteMessage
  | McpWriteMessage
  | AnswerMessage
  | FolderChangeMessage
  | PickFolderMessage
  | TreeReadMessage
  | FileReadMessage
  | FileCloseMessage
  | FileWriteMessage
  | ProvidersWriteMessage;

// A chunk of the model's reply, raw and unsanitized. The frontend escapes it before it shows it.
export interface TextEvent {
  kind: "text";
  text: string;
}

// The reply that is running has ended, so the next output starts on a new line.
export interface ReplyEndEvent {
  kind: "replyEnd";
}

// An approximate count of the thinking tokens so far, while the model thinks.
export interface ThinkingEvent {
  kind: "thinking";
  approximate: number;
}

// The count when the reply ends. `exact` is true when the provider reported it, false for an estimate.
export interface ThinkingDoneEvent {
  kind: "thinkingDone";
  tokens: number;
  exact: boolean;
}

// A tool call the model asked for, described for the user. `description` is raw; the frontend sanitizes it. `id` is
// the call's id, which its result carries.
export interface ToolCallEvent {
  kind: "toolCall";
  id: string;
  description: string;
}

// A tool call that did not run because the session ended. It still gets a tool result in the history.
export interface ToolSkippedEvent {
  kind: "toolSkipped";
  id: string;
  description: string;
}

// The result of a tool call, in call order, after the round's calls have run. `text` is capped by the backend.
export interface ToolResultEvent {
  kind: "toolResult";
  id: string;
  text: string;
}

// A write or command waits for the user. The frontend answers with an approval carrying the same id.
export interface ApprovalRequestEvent {
  kind: "approvalRequest";
  id: number;
  preview: string;
}

// The answer to an approvalRequest, sent once the question is closed. A frontend that reconnects can
// tell from it which approval requests are still open.
export interface ApprovalAnsweredEvent {
  kind: "approvalAnswered";
  id: number;
  answer: ApprovalAnswer;
}

// The messages of the conversation the session now has: the one it starts with, or one that /new or /load
// replaces. A frontend shows them in place of what it showed before. Empty when there are none.
export interface HistoryEvent {
  kind: "history";
  messages: HistoryMessage[];
}

// The named sessions that /load can load, in name order. Sent at the start and after each /save.
export interface SessionsEvent {
  kind: "sessions";
  names: string[];
}

// Every tool and whether it is switched on. Sent at the start and after each change to the switches.
export interface ToolsEvent {
  kind: "tools";
  tools: ToolSwitch[];
}

// The profiles the page can edit, by name and summary. Sent at the start and after each save.
export interface ProfilesEvent {
  kind: "profiles";
  profiles: ProfileSummary[];
}

// One profile's detail, in answer to a profileRead.
export interface ProfileEvent {
  kind: "profile";
  profile: ProfileDetail;
}

// The MCP servers: the ones that started at the start of this session, and the ones the file configures.
// Sent at the start and after each save.
export interface McpEvent {
  kind: "mcp";
  running: McpServerStatus[];
  servers: ScopedMcpServer[];
}

// The model asks the user a question. The frontend answers with an answer message carrying the same id.
export interface AskEvent {
  kind: "ask";
  id: number;
  question: string;
  choices: string[];
}

// The answer to an ask, in the words the model is given. Sent once the question is closed.
export interface AskAnsweredEvent {
  kind: "askAnswered";
  id: number;
  answer: string;
}

// The folder the session works in, sent at the start of each session.
export interface FolderEvent {
  kind: "folder";
  path: string;
}

// The entries of one folder, in answer to a treeRead, or sent at the start of each session for the top folder.
export interface TreeEvent {
  kind: "tree";
  path: string;
  entries: TreeEntry[];
}

// The text of one file, in answer to a fileRead.
export interface FileEvent {
  kind: "file";
  path: string;
  text: string;
  // The text's version, which the page sends back with a save. Optional for the reducer's tests, which predate it.
  version?: string;
}

// The files the session has open, in the order they were opened. Sent after each change to the set. The
// text of a file is not kept: the page reads it again when it needs it.
export interface OpenFilesEvent {
  kind: "openFiles";
  paths: string[];
}

// The llama.cpp servers, without their keys. Sent at the start and after each save.
export interface ProvidersEvent {
  kind: "providers";
  servers: ProviderEntry[];
}

// The current model, and the models the page's selector offers. Sent at the start and after each command.
export interface ModelsEvent {
  kind: "models";
  current: string;
  models: ModelInfo[];
}

// The output of a hook, in full. The frontend caps what it shows.
export interface HookOutputEvent {
  kind: "hookOutput";
  text: string;
}

// A line of information for the user.
export interface NoticeEvent {
  kind: "notice";
  text: string;
}

// A failure for the user. The frontend shows it as "error: <message>".
export interface ErrorEvent {
  kind: "error";
  message: string;
}

// The backend is ready for the next line.
export interface ReadyEvent {
  kind: "ready";
}

// The session has ended. `error` is set when it ended because of a failure. Nothing follows this event.
export interface EndedEvent {
  kind: "ended";
  error?: string;
}

export type ServerEvent =
  | TextEvent
  | ReplyEndEvent
  | ThinkingEvent
  | ThinkingDoneEvent
  | ToolCallEvent
  | ToolSkippedEvent
  | ToolResultEvent
  | ApprovalRequestEvent
  | ApprovalAnsweredEvent
  | AskEvent
  | AskAnsweredEvent
  | HistoryEvent
  | SessionsEvent
  | ToolsEvent
  | ProfilesEvent
  | ProfileEvent
  | McpEvent
  | FolderEvent
  | TreeEvent
  | FileEvent
  | OpenFilesEvent
  | ProvidersEvent
  | ModelsEvent
  | HookOutputEvent
  | NoticeEvent
  | ErrorEvent
  | ReadyEvent
  | EndedEvent;

// One running session. The frontend sends messages in and reads events out, in the order they happen.
export interface Session {
  send(message: ClientMessage): void;
  events(): AsyncIterable<ServerEvent>;
}

// Where the backend puts its events. The backend calls it in order, and never waits on it.
export type Emit = (event: ServerEvent) => void;
