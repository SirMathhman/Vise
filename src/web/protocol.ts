// Wire-protocol types for the web frontend's WebSocket. Pure types; no I/O.
// Shared by the server (src/web/webTransport.ts, src/web/server.ts) and the
// browser client (web/app.js). The server serializes ServerMessage frames to
// JSON; the client deserializes ClientMessage frames it sends.

// Server -> client. One frame per transport render call or state change.
export type ServerMessage =
  | { type: "prompt" }
  | { type: "reply_delta"; text: string }
  | { type: "reply_end" }
  | { type: "reply_cancel" }
  | {
      type: "question";
      question: string;
      kind: "freeform" | "multiple_choice" | "multiple_select";
      options?: string[];
    }
  | {
      type: "tool_call_start";
      name: string;
      args: Record<string, unknown>;
      depth: number;
    }
  | {
      type: "tool_call_end";
      name: string;
      durationMs: number;
      status: "done" | "failed" | "disabled" | "unknown";
      depth: number;
    }
  | {
      type: "command";
      lines: string[];
      isError?: boolean;
      // Current saved-session names (see CommandRender); lets the client's
      // sessions panel refresh from the same round trip as /save and
      // /sessions (list/delete/rename), without a follow-up request.
      sessionNames?: string[];
    }
  | { type: "error"; message: string }
  | { type: "hook"; label: string; output: string; exitCode: number }
  | { type: "compact_notice" }
  | { type: "log"; message: string }
  | {
      type: "status";
      phase: "thinking" | "prefill" | "done";
      elapsedMs: number;
      tokens?: number;
      processed?: number;
      total?: number;
      cache?: number;
    }
  | { type: "done" }
  // Sent to a second browser while another one holds the session.
  | { type: "session_in_use" };

// Client -> server. `input` carries one line of user input (a regular message
// OR an ask_user answer; both feed the same line queue). `close` is a
// user-initiated exit.
export type ClientMessage = { type: "input"; text: string } | { type: "close" };
