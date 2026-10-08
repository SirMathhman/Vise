import type { CallPurpose } from "../../src/core/errors.ts";
import type { HistoryEntry } from "./history.ts";
import type { HooksFields } from "./hooks-panel.ts";

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
  /** `state`: a line is running on the server, and whether it can be steered. */
  running?: boolean;
  steerable?: boolean;
}
