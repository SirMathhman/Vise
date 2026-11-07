// The contract between the frontend and the backend. Every message is plain data (no functions, no
// class instances), so each one could cross a pipe or a socket later without change.

import type { ApprovalAnswer } from "../core/commands.ts";
import type { HistoryMessage } from "../core/sessions.ts";

export type { ApprovalAnswer, HistoryMessage };

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

export type ClientMessage =
  | LineMessage
  | ApprovalMessage
  | InputEndedMessage
  | FailedMessage;

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

// A tool call the model asked for, described for the user. `description` is raw; the frontend sanitizes it.
export interface ToolCallEvent {
  kind: "toolCall";
  description: string;
}

// A tool call that did not run because the session ended. It still gets a tool result in the history.
export interface ToolSkippedEvent {
  kind: "toolSkipped";
  description: string;
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
  | ApprovalRequestEvent
  | ApprovalAnsweredEvent
  | HistoryEvent
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
