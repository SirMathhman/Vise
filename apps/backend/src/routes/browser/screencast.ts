/**
 * The CDP screencast half of the model-driven browser session: it turns the
 * (headless) Playwright page into a live stream of JPEG frames the viewer
 * panel can paint, and forwards the user's clicks/keys/scrolls back into the
 * page as synthetic input events.
 *
 * Why a screencast at all: Vise's own URL tabs render a page in a cross-origin
 * `<iframe>` that Vise's DOM cannot script, and most sites refuse to be framed
 * (X-Frame-Options / CSP frame-ancestors). VS Code can host a real web-contents
 * view because it is Electron; Vise is itself a page in a browser and has no
 * native shell, so the only way to show a *real* browser inside the panel is to
 * mirror it — exactly what VS Code's own Browser Preview extension did inside a
 * webview. The model's element-number tools (browser_click/browser_type) and
 * this stream drive the same page, so the user watches the model work.
 *
 * Lifecycle: this module owns the CDP session, never the page or the browser —
 * `session.ts` owns those and calls `attach` whenever it creates a page and
 * `close` on teardown. The screencast itself runs only while at least one
 * subscriber is listening AND a page is attached, so nothing encodes frames
 * that nobody is watching.
 */

import type { Page } from "playwright-core";

/** JPEG quality for streamed frames: a readable page at a modest bitrate. */
const FRAME_QUALITY = 60;
/** Hard ceiling on a streamed frame's dimensions, whatever the viewport is. */
const MAX_FRAME_WIDTH = 1920;
const MAX_FRAME_HEIGHT = 1200;

/**
 * The per-frame geometry the client needs to map a click on its canvas back
 * to a coordinate in the page. Mirrors CDP's `ScreencastFrameMetadata`.
 */
export interface FrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

/** One streamed frame: a base64 JPEG, the geometry to place it, and the
 * page's current URL. The URL rides along on every frame because the page can
 * navigate without the panel asking it to — the model's browser_click may
 * follow a link — and the panel's title would otherwise still name the page
 * the user originally opened. */
export interface ScreencastFrame {
  data: string;
  meta: FrameMetadata;
  url: string;
}

/**
 * A user input event to replay into the page. Deliberately a narrow subset of
 * CDP's Input domain — printable keys and the basics of pointer interaction —
 * because the model's element-number tools remain the reliable path for
 * automation; this exists so a human can drive the same page by hand.
 */
export type BrowserInput =
  | {
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved";
      x: number;
      y: number;
      button?: "left" | "right" | "middle" | "none";
      clickCount?: number;
      modifiers?: number;
    }
  | {
      kind: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      kind: "key";
      type: "keyDown" | "keyUp" | "char";
      key?: string;
      code?: string;
      text?: string;
      windowsVirtualKeyCode?: number;
      modifiers?: number;
    };

export interface Screencast {
  /** Bind to a (new) page; detaches from any previous one. */
  attach(page: Page): Promise<void>;
  /** Listen for frames. Starts the screencast if this is the first listener. */
  subscribe(cb: (frame: ScreencastFrame) => void): () => void;
  /** Resize the page viewport so the stream matches the panel's size. */
  setViewport(width: number, height: number): Promise<void>;
  /** Replay a user input event into the page. */
  dispatchInput(input: BrowserInput): Promise<void>;
  /** Detach and stop streaming. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * The structural shape of Playwright's CDPSession that this module uses. Typed
 * locally rather than against the bundled protocol types so the module does not
 * couple to a generated `Protocol` namespace that may move between versions —
 * the same reasoning as `BrowserElement` in elements.ts.
 */
interface RawCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (payload: unknown) => void): void;
  detach(): Promise<void>;
}

/** The payload CDP delivers on `Page.screencastFrame`. */
interface RawFrameEvent {
  data?: unknown;
  sessionId?: unknown;
  metadata?: Partial<FrameMetadata>;
}

/** Coerce a CDP frame's metadata into the full shape, defaulting missing fields. */
function toMetadata(raw: Partial<FrameMetadata> | undefined): FrameMetadata {
  return {
    offsetTop: raw?.offsetTop ?? 0,
    pageScaleFactor: raw?.pageScaleFactor ?? 1,
    deviceWidth: raw?.deviceWidth ?? 0,
    deviceHeight: raw?.deviceHeight ?? 0,
    scrollOffsetX: raw?.scrollOffsetX ?? 0,
    scrollOffsetY: raw?.scrollOffsetY ?? 0,
  };
}

/** Translate one input event into its CDP method + parameters. */
function toCdpInput(input: BrowserInput): {
  method: string;
  params: Record<string, unknown>;
} {
  if (input.kind === "mouse") {
    return {
      method: "Input.dispatchMouseEvent",
      params: {
        type: input.type,
        x: input.x,
        y: input.y,
        button: input.button ?? "left",
        clickCount: input.clickCount ?? 1,
        modifiers: input.modifiers ?? 0,
      },
    };
  }
  if (input.kind === "wheel") {
    return {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseWheel",
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers ?? 0,
      },
    };
  }
  return {
    method: "Input.dispatchKeyEvent",
    params: {
      type: input.type,
      key: input.key ?? "",
      code: input.code ?? "",
      text: input.text ?? "",
      windowsVirtualKeyCode: input.windowsVirtualKeyCode ?? 0,
      modifiers: input.modifiers ?? 0,
    },
  };
}

export function createScreencast(): Screencast {
  const subscribers = new Set<(frame: ScreencastFrame) => void>();
  let page: Page | undefined;
  let cdp: RawCdpSession | undefined;
  /** True while CDP is actively encoding frames for us. */
  let streaming = false;
  /** The panel's last requested size, replayed onto each newly attached page. */
  let viewport = { width: 1280, height: 800 };

  /**
   * Acknowledge a frame and fan it out. CDP stalls the stream if frames are
   * not acked, so the ack must happen even when there are no subscribers left
   * (a race during teardown) — hence the ack before the fan-out.
   */
  function onFrame(payload: unknown): void {
    const raw = payload as RawFrameEvent;
    const sessionId = raw.sessionId;
    if (cdp && sessionId !== undefined) {
      // Fire-and-forget: a failed ack means the session is gone, and the
      // detach path has already (or is about to) tear everything down.
      void cdp
        .send("Page.screencastFrameAck", { sessionId: sessionId as number })
        .catch(() => {});
    }
    if (typeof raw.data !== "string") return;
    const frame: ScreencastFrame = {
      data: raw.data,
      meta: toMetadata(raw.metadata),
      // Sync in Playwright and just a field read, so this is cheap per frame.
      url: page?.url() ?? "",
    };
    for (const cb of subscribers) cb(frame);
  }

  /** Begin encoding frames, if a page is attached and anyone is listening. */
  async function maybeStart(): Promise<void> {
    if (streaming || !cdp || subscribers.size === 0) return;
    streaming = true;
    try {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: FRAME_QUALITY,
        maxWidth: MAX_FRAME_WIDTH,
        maxHeight: MAX_FRAME_HEIGHT,
        everyNthFrame: 1,
      });
    } catch {
      // The page went away between the check and the call; the next attach
      // will start a fresh screencast.
      streaming = false;
    }
  }

  /** Stop encoding once the last subscriber leaves, so idle costs nothing. */
  async function maybeStop(): Promise<void> {
    if (!streaming || !cdp || subscribers.size > 0) return;
    streaming = false;
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      // Already gone; nothing to stop.
    }
  }

  async function detach(): Promise<void> {
    const session = cdp;
    cdp = undefined;
    page = undefined;
    streaming = false;
    if (!session) return;
    try {
      await session.detach();
    } catch {
      // The page or browser is already closed; the session died with it.
    }
  }

  return {
    async attach(next) {
      await detach();
      page = next;
      const session = await next
        .context()
        .newCDPSession(next)
        .catch(() => undefined);
      if (!session) return;
      cdp = session as unknown as RawCdpSession;
      cdp.on("Page.screencastFrame", onFrame);
      await next.setViewportSize(viewport).catch(() => {});
      await maybeStart();
    },

    subscribe(cb) {
      subscribers.add(cb);
      void maybeStart();
      return () => {
        subscribers.delete(cb);
        void maybeStop();
      };
    },

    async setViewport(width, height) {
      viewport = {
        width: Math.max(1, Math.trunc(width)),
        height: Math.max(1, Math.trunc(height)),
      };
      if (!page) return;
      await page.setViewportSize(viewport).catch(() => {});
    },

    async dispatchInput(input) {
      if (!cdp) return;
      const { method, params } = toCdpInput(input);
      await cdp.send(method, params).catch(() => {});
    },

    close: detach,
  };
}
