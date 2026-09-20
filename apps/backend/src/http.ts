import type { ServerResponse } from "node:http";

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

/**
 * Open a Server-Sent-Events stream. A streaming route owns its response — the
 * dispatch loop skips the usual JSON body mapping for it — so the headers live
 * here alongside `sendJson` rather than being re-typed per stream. Shared by
 * `/api/watch` and the browser screencast stream.
 */
export function sendSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Prime the stream; some clients only fire "open" after the first bytes.
  res.write(":ok\n\n");
}
