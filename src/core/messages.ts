import type { ToolSpec } from "./tools.ts";
// Shared data types and the ports the core and backend use, and the Result type for failures.

export interface Ok<T> {
  ok: true;
  value: T;
}

export interface Err<E = Error> {
  ok: false;
  error: E;
}

// A value or a failure, returned instead of thrown.
export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E = Error>(error: E): Err<E> {
  return { ok: false, error };
}

// A call the model asked for. arguments is the JSON text the model wrote.
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

// The history as the model is sent it. The instructions (AGENTS.md) go in front of the first message in every
// request, so the stored history holds only what was written and compaction cannot drop them. A stored first
// message that already starts with the instructions (a conversation saved before this) is not given them twice.
export function withInstructions(history: ChatMessage[], instructions: string | undefined): ChatMessage[] {
  const first = history[0];
  if (instructions === undefined || first?.role !== "user") return history;
  if (first.content.startsWith(instructions)) return history;
  return [{ role: "user", content: `${instructions}\n\n${first.content}` }, ...history.slice(1)];
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
  // The reasoning items the provider sent with the tool calls, kept exactly as they came. They go back
  // with the next request, because the provider may need them to continue after a tool call.
  reasoning?: unknown[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

// Token counts the provider reports for one request, taken from the stream. reasoningTokens is the
// exact count of thinking tokens, reported at the end of the reply; absent when the provider gives none.
export interface Usage {
  promptTokens: number;
  reasoningTokens?: number;
}

// How hard the model thinks before it answers. Absent means reasoning is off.
export type ReasoningEffort = "low" | "medium" | "high";

// What one request to the model needs. Usage and tool calls are reported through the callbacks, tool
// calls once the reply ends. `tools` names the tools the model is offered in this request. `reasoning`
// turns thinking on at that effort. `onThinking` reports an approximate count of the thinking tokens so
// far, while the model thinks. `onReasoning` receives the reasoning items once the reply ends.
export interface ReplyRequest {
  messages: ChatMessage[];
  onUsage(usage: Usage): void;
  onToolCall(call: ToolCall): void;
  tools: string[];
  reasoning: ReasoningEffort | undefined;
  onThinking(approximateTokens: number): void;
  onReasoning(items: unknown[]): void;
}

// Sends one request to a model. Text arrives as ok values; a failure is one err value, and nothing follows it.
export type Reply = (request: ReplyRequest) => AsyncIterable<Result<string>>;

export type ContextWindow = () => Promise<Result<number>>;

// A model a provider lists: its id, and its context window in tokens.
export interface ModelInfo {
  id: string;
  contextLength: number;
}

// What the session needs from a model provider. A request names the model to use and the tools of the MCP
// servers that started. The provider names its models in its own way; `defaultModel` is one of them.
export interface ProviderRequest extends ReplyRequest {
  model: string;
  extraTools: ToolSpec[];
}

// The variables that hold each provider's key. A child process never receives them (src/tools/process/child-env.ts).
// A new provider adds its key variable here.
export const PROVIDER_KEY_VARIABLES: readonly string[] = ["OPENROUTER_API_KEY"];

export interface Provider {
  defaultModel: string;
  reply(request: ProviderRequest): AsyncIterable<Result<string>>;
  contextWindow(model: string): Promise<Result<number>>;
  listModels(): Promise<Result<ModelInfo[]>>;
}

// The model the session uses, and the models it may switch to. `select` refuses a name that is not
// listed, and resolves with the name it chose.
export interface ModelPorts {
  current(): string;
  list(): Promise<Result<ModelInfo[]>>;
  select(name: string): Promise<Result<string>>;
}

// One MCP server as .vise/mcp.json configures it: a program started over stdio, or an endpoint reached over
// HTTP with optional headers (for example an Authorization token).
export interface StdioServerEntry {
  kind: "stdio";
  name: string;
  command: string;
  args: string[];
}

export interface HttpServerEntry {
  kind: "http";
  name: string;
  url: string;
  headers: Record<string, string>;
}

export type McpServerEntry = StdioServerEntry | HttpServerEntry;

// Where a configured item lives: the project folder's .vise file, or the user's home .vise file. Absent when only
// one file is read, so the item's file is that file.
export type Scope = "local" | "global";

export interface ScopeField {
  scope?: Scope;
}

export type ScopedMcpServer = McpServerEntry & ScopeField;

// One MCP server as it went at the start of this session: whether it started, the names of its tools,
// and each reason a server or one of its tools was left out.
export interface McpServerStatus {
  name: string;
  started: boolean;
  tools: string[];
  problems: string[];
}

// Where the page and /mcp read the MCP servers: the ones that started, and the ones the file configures.
export interface McpStore {
  running(): McpServerStatus[];
  config(): Promise<Result<ScopedMcpServer[]>>;
  save(servers: ScopedMcpServer[]): Promise<Result<void>>;
}

// A provider kind: an OpenRouter account, or a llama.cpp server.
export type ProviderKind = "openrouter" | "llama.cpp";

// One provider as the page sees it: its kind, name, and URL (blank for OpenRouter). Never its key.
export interface ProviderEntry extends ScopeField {
  kind: ProviderKind;
  name: string;
  url: string;
  keySaved: boolean;
}

// One provider as the page sends it. A blank key keeps the key saved for a provider of the same name.
export interface ProviderInput extends ScopeField {
  kind: ProviderKind;
  name: string;
  url: string;
  apiKey: string;
}

// Where the page reads and saves the llama.cpp servers in .vise/providers.json. A change applies at the next start.
export interface ProvidersStore {
  list(): Promise<Result<ProviderEntry[]>>;
  save(servers: ProviderInput[]): Promise<Result<void>>;
}

// Where file changes are recorded for /undo. A change runs inside `around`, so what it did can be reverted.
// A file's text, and its version: a hash of the text. A save names the version it was based on.
export interface FileText {
  text: string;
  version: string;
}

export interface UndoStore {
  // Starts a turn: each message of the user is one turn.
  startTurn(): void;
  // The turns back that /undo can return to, as numbers. 1 is the most recent turn.
  points(): number[];
  // Puts the files back to the start of the turn that is `turnsBack` back.
  revert(turnsBack: number): Promise<Result<string[]>>;
  // Runs a change to the file at `path`, relative to the working directory, and records it.
  around(path: string, run: () => Promise<string>): Promise<string>;
}

// One entry of a folder, as the file tree shows it. `path` is relative to the working directory.
export interface TreeEntry {
  name: string;
  path: string;
  directory: boolean;
}
