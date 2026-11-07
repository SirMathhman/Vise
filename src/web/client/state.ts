import type { ApprovalAnswer } from "../../core/commands.ts";
import type { ServerEvent } from "../../protocol/protocol.ts";

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
};

// The approval question still open, if any. The page locks its input while one is open, because the
// backend reads the next line as the answer.
export function openApproval(state: ViewState): ApprovalBlock | undefined {
  return state.blocks.findLast(
    (block): block is ApprovalBlock =>
      block.kind === "approval" && block.answer === undefined,
  );
}

// Whether the page may send a line now.
export function canSend(state: ViewState): boolean {
  return (
    state.link === "live" &&
    !state.ended &&
    openApproval(state) === undefined
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

function answerApproval(
  blocks: Block[],
  id: number,
  answer: ApprovalAnswer,
): Block[] {
  return blocks.map((block) =>
    block.kind === "approval" && block.id === id ? { ...block, answer } : block,
  );
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
      };
    case "approvalAnswered":
      return { ...state, blocks: answerApproval(blocks, event.id, event.answer) };
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
