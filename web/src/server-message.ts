import type { ListsSnapshot } from "../../src/repl/lists.ts";
import type { CallPurpose } from "../../src/core/errors.ts";
import type { HistoryEntry } from "./log/history.ts";
import type { HooksFields } from "./settings/hooks/hooks-panel.ts";

/** The fields of a message from the server that the page reads (see the protocol in `src/web/server.ts`). */
export interface ResultMessage {
  ok?: boolean;
  value?: string;
  error?: string;
  context?: string;
  streamed?: boolean;
  compactionWarning?: string;
  /** Echo of the request id, set for editor-side requests only. */
  id?: string;
}

export interface ServerMessage extends ResultMessage, HooksFields {
  type: string;
  text?: string;
  name?: string;
  depth?: number;
  id?: string;
  entries?: HistoryEntry[];
  label?: string;
  width?: number;
  height?: number;
  active?: boolean;
  tools?: string[] | null;
  question?: string;
  options?: string[];
  /** `ask`: what each choice means, parallel to `options` ("" for none). */
  descriptions?: string[];
  /** `ask`: several choices may be picked. */
  multiSelect?: boolean;
  tab?: number;
  tabs?: { id: number; url: string; title: string }[];
  data?: string;
  message?: string;
  /** `queue`: the lines held until the work in flight is done. `line_started`: which held line began. */
  items?: { qid: string; text: string }[];
  qid?: string;
  /** `progress`: llama.cpp prompt processing (tokens). */
  total?: number;
  cache?: number;
  processed?: number;
  time_ms?: number;
  /** `progress`: which model request this belongs to (a new number is a new request). */
  request?: number;
  /** `progress`: what the model call is for. */
  purpose?: CallPurpose;
  /** `generating`: tokens the call has written so far, and whether it has ended. */
  tokens?: number;
  /** `generating`: set on the report that follows a call's end (the context fill, not a generation). */
  used?: number;
  done?: boolean;
  /** `todos`: the agent's todo list. */
  todos?: { content: string; status: string }[];
  /** `tool`: the call's arguments; `tool_result`: its whole result (both clipped), for the line's details. */
  detail?: string;
  /** `state`: a line is running on the server, and whether it can be steered. */
  running?: boolean;
  steerable?: boolean;
  /** `lists`: what the header, tools panel and session menu show (`ListsSnapshot`, src/repl/lists.ts). */
  lists?: ListsSnapshot;
}
