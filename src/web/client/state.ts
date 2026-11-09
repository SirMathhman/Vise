import type {
  ApprovalAnswer,
  HistoryMessage,
  McpServerEntry,
  McpServerStatus,
  ProfileDetail,
  ProfileSummary,
  ServerEvent,
  ToolSwitch,
} from "../../protocol/protocol.ts";

// What the page knows about its connection to the server.
export type Link = "connecting" | "live" | "lost" | "taken" | "no-token";

export interface UserBlock {
  kind: "user";
  text: string;
}

export interface ReplyBlock {
  kind: "reply";
  text: string;
  done: boolean;
}

export interface ThinkingBlock {
  kind: "thinking";
  tokens: number;
  exact: boolean;
  done: boolean;
}

export interface ToolBlock {
  kind: "tool";
  description: string;
  skipped: boolean;
}

// A question the model asked. Its answer is set once the question is closed.
export interface AskBlock {
  kind: "ask";
  id: number;
  question: string;
  choices: string[];
  answer?: string;
}

export interface ApprovalBlock {
  kind: "approval";
  id: number;
  preview: string;
  answer?: ApprovalAnswer;
}

export interface HookBlock {
  kind: "hook";
  text: string;
}

export interface NoticeBlock {
  kind: "notice";
  text: string;
}

export interface ErrorBlock {
  kind: "error";
  message: string;
}

// One item of the transcript, in the order it happened.
export type Block =
  | UserBlock
  | ReplyBlock
  | ThinkingBlock
  | ToolBlock
  | ApprovalBlock
  | AskBlock
  | HookBlock
  | NoticeBlock
  | ErrorBlock;

export interface ViewState {
  link: Link;
  blocks: Block[];
  // True from the time a line is sent until the backend says it is ready for the next one.
  waiting: boolean;
  ended: boolean;
  endError?: string;
  // The id of the newest approval question shown on the page. Sent with each line (see LineMessage).
  lastShown: number;
  // The named sessions /load can load, from the last sessions event.
  sessions: string[];
  // Every tool and whether it is switched on, from the last tools event.
  tools: ToolSwitch[];
  // The profiles the page can edit, and the one whose detail arrived last (the editor opens on it).
  profiles: ProfileSummary[];
  profile?: ProfileDetail;
  // The MCP servers as they went at the start, and as the file configures them, from the last mcp event.
  mcp?: McpInfo;
}

export interface McpInfo {
  running: McpServerStatus[];
  servers: McpServerEntry[];
}

// A line the user sent from the page.
export interface SentAction {
  kind: "sent";
  text: string;
}

// An event the server sent.
export interface ServerAction {
  kind: "server";
  event: ServerEvent;
}

export interface LinkAction {
  kind: "link";
  link: Link;
}

// A new connection starts: the server replays the session, so the transcript starts again.
export interface ResetAction {
  kind: "reset";
}

export type ViewAction = SentAction | ServerAction | LinkAction | ResetAction;

export const initialState: ViewState = {
  link: "connecting",
  blocks: [],
  waiting: false,
  ended: false,
  lastShown: 0,
  sessions: [],
  tools: [],
  profiles: [],
};

// The approval question still open, if any. The page locks its input while one is open, because the
// backend reads the next line as the answer.
// The question the model asked that is still open, if any.
export function openAsk(state: ViewState): AskBlock | undefined {
  return state.blocks.findLast(
    (block): block is AskBlock => block.kind === "ask" && block.answer === undefined,
  );
}

export function openApproval(state: ViewState): ApprovalBlock | undefined {
  return state.blocks.findLast(
    (block): block is ApprovalBlock =>
      block.kind === "approval" && block.answer === undefined,
  );
}

// Whether the page may send a line now.
// The tool list to save after an edit. `original` is the profile's own list, undefined when it has none.
// `shown` is every tool the editor offers and `checked` the ones ticked. Names the editor does not offer
// stay, so saving never drops them; a profile with no list keeps none unless the user ticks some.
export function toolsAfterEdit(
  original: string[] | undefined,
  shown: string[],
  checked: string[],
): string[] | undefined {
  if (original === undefined) {
    return checked.length === shown.length ? undefined : checked;
  }
  const kept = original.filter((name) => !shown.includes(name) || checked.includes(name));
  const added = checked.filter((name) => !original.includes(name));
  return [...kept, ...added];
}

export function canSend(state: ViewState): boolean {
  return (
    state.link === "live" &&
    !state.ended &&
    openApproval(state) === undefined &&
    openAsk(state) === undefined
  );
}

function addText(blocks: Block[], text: string): Block[] {
  const last = blocks.at(-1);
  if (last?.kind === "reply" && !last.done) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...blocks, { kind: "reply", text, done: false }];
}

function endReply(blocks: Block[]): Block[] {
  const last = blocks.at(-1);
  if (last?.kind !== "reply" || last.done) return blocks;
  return [...blocks.slice(0, -1), { ...last, done: true }];
}

function addThinking(blocks: Block[], tokens: number): Block[] {
  const last = blocks.at(-1);
  if (last?.kind === "thinking" && !last.done) {
    return [...blocks.slice(0, -1), { ...last, tokens }];
  }
  return [...blocks, { kind: "thinking", tokens, exact: false, done: false }];
}

function endThinking(blocks: Block[], tokens: number, exact: boolean): Block[] {
  const last = blocks.at(-1);
  if (last?.kind !== "thinking" || last.done) return blocks;
  return [...blocks.slice(0, -1), { ...last, tokens, exact, done: true }];
}

function answerAsk(blocks: Block[], id: number, answer: string): Block[] {
  return blocks.map((block) =>
    block.kind === "ask" && block.id === id ? { ...block, answer } : block,
  );
}

function answerApproval(
  blocks: Block[],
  id: number,
  answer: ApprovalAnswer,
): Block[] {
  return blocks.map((block) =>
    block.kind === "approval" && block.id === id ? { ...block, answer } : block,
  );
}

// A message of an earlier conversation, shown as it was: a line of the user, or a finished reply.
function historyBlock(message: HistoryMessage): Block {
  if (message.role === "user") return { kind: "user", text: message.text };
  return { kind: "reply", text: message.text, done: true };
}

function applyEvent(state: ViewState, event: ServerEvent): ViewState {
  const blocks = state.blocks;
  switch (event.kind) {
    case "text":
      return { ...state, blocks: addText(blocks, event.text) };
    case "replyEnd":
      return { ...state, blocks: endReply(blocks) };
    case "thinking":
      return { ...state, blocks: addThinking(blocks, event.approximate) };
    case "thinkingDone":
      return {
        ...state,
        blocks: endThinking(blocks, event.tokens, event.exact),
      };
    case "toolCall":
      return {
        ...state,
        blocks: [...blocks, { kind: "tool", description: event.description, skipped: false }],
      };
    case "toolSkipped":
      return {
        ...state,
        blocks: [...blocks, { kind: "tool", description: event.description, skipped: true }],
      };
    case "approvalRequest":
      return {
        ...state,
        blocks: [...blocks, { kind: "approval", id: event.id, preview: event.preview }],
        lastShown: event.id,
      };
    case "approvalAnswered":
      return { ...state, blocks: answerApproval(blocks, event.id, event.answer) };
    case "ask":
      return {
        ...state,
        blocks: [...blocks, { kind: "ask", id: event.id, question: event.question, choices: event.choices }],
        lastShown: event.id,
      };
    case "askAnswered":
      return { ...state, blocks: answerAsk(blocks, event.id, event.answer) };
    case "history":
      return { ...state, blocks: event.messages.map(historyBlock) };
    case "sessions":
      return { ...state, sessions: event.names };
    case "tools":
      return { ...state, tools: event.tools };
    case "profiles":
      return { ...state, profiles: event.profiles };
    case "profile":
      return { ...state, profile: event.profile };
    case "mcp":
      return { ...state, mcp: { running: event.running, servers: event.servers } };
    case "hookOutput":
      if (event.text === "") return state;
      return { ...state, blocks: [...blocks, { kind: "hook", text: event.text }] };
    case "notice":
      return { ...state, blocks: [...blocks, { kind: "notice", text: event.text }] };
    case "error":
      return { ...state, blocks: [...blocks, { kind: "error", message: event.message }] };
    case "ready":
      return { ...state, waiting: false };
    case "ended":
      return { ...state, waiting: false, ended: true, endError: event.error };
  }
}

// The whole page state as a function of what happened. It has no side effects, so it is tested on
// its own.
export function reduce(state: ViewState, action: ViewAction): ViewState {
  switch (action.kind) {
    case "sent":
      return {
        ...state,
        waiting: true,
        blocks: [...state.blocks, { kind: "user", text: action.text }],
      };
    case "server":
      return applyEvent(state, action.event);
    case "link":
      return { ...state, link: action.link };
    case "reset":
      return { ...initialState, link: state.link };
  }
}
