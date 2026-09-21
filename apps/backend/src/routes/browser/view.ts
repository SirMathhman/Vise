/**
 * The HTTP surface for the viewer panel's browser tab: a screencast stream out,
 * and navigation/input/viewport control in. These are panel-facing routes, not
 * LLM tools — the model drives the same page through `/api/llm/tool`
 * (browser_open/click/type/drag in session.ts), and both act on the one app-owned
 * session, which is the point: the user watches the model work.
 *
 * The stream mirrors `routes/watch.ts` exactly — same SSE headers, same
 * subscribe + `res.on("close")` teardown — so the two streaming routes in this
 * codebase read the same way.
 */

import type { AppContext } from "../../context.js";
import { badRequest } from "../../errors.js";
import { sendJson, sendSseHeaders } from "../../http.js";
import type { Route } from "../../router.js";
import type { BrowserInput } from "./screencast.js";

/** Read a finite number from an unknown JSON field, or fall back. */
function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Validate a posted input event. Returns null for anything unrecognized rather
 * than throwing, so a malformed event from a stale client is a 400 with a
 * readable message instead of an exception in the dispatch loop.
 */
function parseInput(raw: Record<string, unknown>): BrowserInput | null {
  const kind = raw.kind;
  if (kind === "mouse") {
    const type = raw.type;
    if (
      type !== "mousePressed" &&
      type !== "mouseReleased" &&
      type !== "mouseMoved"
    ) {
      return null;
    }
    const button = raw.button;
    return {
      kind: "mouse",
      type,
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      button:
        button === "right" || button === "middle" || button === "none"
          ? button
          : "left",
      clickCount: num(raw.clickCount, 1),
      modifiers: num(raw.modifiers, 0),
    };
  }
  if (kind === "wheel") {
    return {
      kind: "wheel",
      x: num(raw.x, 0),
      y: num(raw.y, 0),
      deltaX: num(raw.deltaX, 0),
      deltaY: num(raw.deltaY, 0),
      modifiers: num(raw.modifiers, 0),
    };
  }
  if (kind === "key") {
    const type = raw.type;
    if (type !== "keyDown" && type !== "keyUp" && type !== "char") return null;
    return {
      kind: "key",
      type,
      key: typeof raw.key === "string" ? raw.key : "",
      code: typeof raw.code === "string" ? raw.code : "",
      text: typeof raw.text === "string" ? raw.text : "",
      windowsVirtualKeyCode: num(raw.windowsVirtualKeyCode, 0),
      modifiers: num(raw.modifiers, 0),
    };
  }
  return null;
}

export function browserViewRoutes(ctx: AppContext): Route[] {
  const session = ctx.browserSession;
  return [
    {
      method: "GET",
      pattern: "/api/browser/stream",
      streaming: true,
      handler: (_req, res) => {
        sendSseHeaders(res);

        // Backpressure: a screencast produces frames far faster than a stalled
        // socket drains. When a write doesn't flush we skip frames until the
        // socket drains, rather than queueing an unbounded backlog of stale
        // images the user would then watch in slow motion.
        let saturated = false;
        res.on("drain", () => {
          saturated = false;
        });

        const unsubscribe = session.subscribeFrames((frame) => {
          if (saturated) return;
          const flushed = res.write(`data: ${JSON.stringify(frame)}\n\n`);
          if (!flushed) saturated = true;
        });

        res.on("close", unsubscribe);
      },
    },
    {
      method: "POST",
      pattern: "/api/browser/navigate",
      handler: async (_req, res, _params, body) => {
        const payload = (body ?? {}) as { url?: unknown };
        const url = typeof payload.url === "string" ? payload.url : "";
        const resolved = await session.navigate(url);
        sendJson(res, 200, { url: resolved });
      },
    },
    {
      method: "POST",
      pattern: "/api/browser/input",
      handler: async (_req, res, _params, body) => {
        const input = parseInput((body ?? {}) as Record<string, unknown>);
        if (!input) throw badRequest("unrecognized browser input event");
        await session.dispatchInput(input);
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/browser/viewport",
      handler: async (_req, res, _params, body) => {
        const payload = (body ?? {}) as { width?: unknown; height?: unknown };
        const width = num(payload.width, 0);
        const height = num(payload.height, 0);
        if (width <= 0 || height <= 0) {
          throw badRequest("width and height must be positive numbers");
        }
        await session.setViewport(width, height);
        sendJson(res, 200, { width, height });
      },
    },
  ];
}
