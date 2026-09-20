/**
 * The viewer panel's CDP-backed browser tab: paints the screencast of the real
 * Chrome page into a `<canvas>` and replays the user's pointer/keyboard input
 * back into it.
 *
 * This is the half of "mimic VS Code's integrated browser" that a non-Electron
 * host can actually do. A plain `<iframe>` (the `kind: "url"` tab) can't script
 * a cross-origin page and most sites refuse to be framed at all, so instead the
 * backend runs the page headless and streams frames (see
 * routes/browserScreencast.ts). Because the model's browser_click/browser_type
 * tools drive that same page, whatever the model does shows up here live.
 *
 * Teardown is self-healing rather than call-site driven: the viewer clears
 * `#viewer-body` wholesale in several places (renderEditor, openUrl, setHint,
 * closeTab), so rather than hooking every one of them, the view notices its own
 * canvas has left the DOM — on the next frame, or on a slow interval when no
 * frames are arriving — and disposes itself. The interval matters because CDP
 * only emits a frame when the page changes visually: a static page would
 * otherwise never notice it had been detached.
 */

import {
  type BrowserFrame,
  type BrowserInputEvent,
  navigateBrowser,
  sendBrowserInput,
  setBrowserViewport,
  subscribeToBrowserFrames,
} from "../api/client.js";

/** How often to check for a disconnected canvas when no frames are arriving. */
const ORPHAN_CHECK_MS = 2000;

/** CDP modifier bitmask values. */
const MOD_ALT = 1;
const MOD_CTRL = 2;
const MOD_META = 4;
const MOD_SHIFT = 8;

/**
 * Windows virtual key codes for the non-printable keys this view forwards.
 * CDP needs the VK code (not just `key`) for these to register as real key
 * presses in the page. Printable characters go through `text` instead and
 * need no entry here.
 */
const VK: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

/**
 * The page's CSS-pixel viewport size, read from the latest frame's metadata.
 * Shared mutable state between the painter (which writes it) and the input
 * wiring (which reads it to map canvas coordinates into the page).
 */
interface PageGeometry {
  width: number;
  height: number;
}

/** The one active view, if any. At most one browser tab exists at a time. */
let active: { dispose(): void } | null = null;

/** Pack a DOM event's modifier keys into CDP's bitmask. */
function modifiersOf(e: MouseEvent | KeyboardEvent | WheelEvent): number {
  return (
    (e.altKey ? MOD_ALT : 0) |
    (e.ctrlKey ? MOD_CTRL : 0) |
    (e.metaKey ? MOD_META : 0) |
    (e.shiftKey ? MOD_SHIFT : 0)
  );
}

/** Decode a base64 JPEG frame into a Blob for `createImageBitmap`. */
function frameToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

/**
 * Paint frames into the canvas, latest-frame-wins. Decoding is async, and a
 * screencast can outrun it, so a frame arriving mid-decode replaces any other
 * frame waiting rather than queueing behind it — the user wants the newest
 * picture, not every picture.
 */
function createPainter(
  canvas: HTMLCanvasElement,
  geom: PageGeometry
): (frame: BrowserFrame) => void {
  const ctx = canvas.getContext("2d");
  let pending: string | null = null;
  let decoding = false;

  async function pump(): Promise<void> {
    decoding = true;
    while (pending !== null) {
      const data = pending;
      pending = null;
      try {
        const bitmap = await createImageBitmap(frameToBlob(data));
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        ctx?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        // A truncated or malformed frame: skip it, the next one repaints.
      }
    }
    decoding = false;
  }

  return (frame) => {
    geom.width = frame.meta.deviceWidth || geom.width;
    geom.height = frame.meta.deviceHeight || geom.height;
    pending = frame.data;
    if (!decoding) void pump();
  };
}

/**
 * Attach pointer/keyboard/wheel listeners that forward into the page. Returns
 * a detach function.
 */
function wireInput(canvas: HTMLCanvasElement, geom: PageGeometry): () => void {
  const send = (input: BrowserInputEvent): void => {
    void sendBrowserInput(input);
  };

  /**
   * Map a pointer event on the canvas to a coordinate in the page's viewport.
   * Normalizing through the canvas's displayed rect keeps clicks correct even
   * while the canvas is being scaled by CSS, or before a viewport resize has
   * landed on the backend.
   */
  const toPagePoint = (e: MouseEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.round(nx * (geom.width || rect.width)),
      y: Math.round(ny * (geom.height || rect.height)),
    };
  };

  const button = (e: MouseEvent): "left" | "right" | "middle" =>
    e.button === 2 ? "right" : e.button === 1 ? "middle" : "left";

  const onMouseDown = (e: MouseEvent): void => {
    canvas.focus();
    const { x, y } = toPagePoint(e);
    send({
      kind: "mouse",
      type: "mousePressed",
      x,
      y,
      button: button(e),
      clickCount: e.detail || 1,
      modifiers: modifiersOf(e),
    });
  };

  const onMouseUp = (e: MouseEvent): void => {
    const { x, y } = toPagePoint(e);
    send({
      kind: "mouse",
      type: "mouseReleased",
      x,
      y,
      button: button(e),
      clickCount: e.detail || 1,
      modifiers: modifiersOf(e),
    });
  };

  const onMouseMove = (e: MouseEvent): void => {
    // Only track movement while a button is held: one POST per hover-rate
    // mousemove would swamp the backend for very little benefit.
    if (e.buttons === 0) return;
    const { x, y } = toPagePoint(e);
    send({
      kind: "mouse",
      type: "mouseMoved",
      x,
      y,
      modifiers: modifiersOf(e),
    });
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const { x, y } = toPagePoint(e);
    // Pass the deltas through unchanged: CDP's mouseWheel uses the same sign
    // convention as the DOM wheel event (positive deltaY scrolls down), so
    // negating here would scroll the wrong way — verified against a tall page,
    // where deltaY:+300 moves scrollOffsetY to 300 and -300 does nothing.
    send({
      kind: "wheel",
      x,
      y,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      modifiers: modifiersOf(e),
    });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const printable = e.key.length === 1;
    const vk = VK[e.key];
    if (!printable && vk === undefined) return;
    e.preventDefault();
    const base = {
      kind: "key" as const,
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: printable ? e.key.toUpperCase().charCodeAt(0) : vk,
      modifiers: modifiersOf(e),
    };
    // `text` on the keyDown is what actually inserts a character; a bare
    // keyDown/keyUp pair moves focus and fires handlers but types nothing.
    send({ ...base, type: "keyDown", text: printable ? e.key : "" });
    send({ ...base, type: "keyUp", text: "" });
  };

  const onContextMenu = (e: Event): void => e.preventDefault();

  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mouseup", onMouseUp);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("contextmenu", onContextMenu);

  return () => {
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("mouseup", onMouseUp);
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("keydown", onKeyDown);
    canvas.removeEventListener("contextmenu", onContextMenu);
  };
}

/** Dispose whatever browser view is currently mounted, if any. */
export function disposeBrowserView(): void {
  active?.dispose();
  active = null;
}

/**
 * Mount the browser surface into `body` and start streaming. Replaces any
 * previously mounted view. `onUrl` reports the settled URL after navigation,
 * so the caller can retitle the tab when a redirect moves it.
 */
export function openBrowserView(
  body: HTMLElement,
  url: string,
  onUrl: (settled: string) => void
): void {
  // The last URL reported upward, so a self-navigation (the model following a
  // link) retitles the tab exactly once rather than on every frame.
  let reportedUrl = url;
  disposeBrowserView();

  const canvas = document.createElement("canvas");
  canvas.className = "browser-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", `browser page: ${url}`);
  body.append(canvas);

  const geom: PageGeometry = { width: 0, height: 0 };
  const paint = createPainter(canvas, geom);
  const detachInput = wireInput(canvas, geom);

  const unsubscribe = subscribeToBrowserFrames((frame) => {
    if (!canvas.isConnected) {
      disposeBrowserView();
      return;
    }
    paint(frame);
    if (frame.url && frame.url !== reportedUrl) {
      reportedUrl = frame.url;
      onUrl(frame.url);
    }
  });

  // Keep the page's viewport matched to the panel so the stream isn't
  // letterboxed and the coordinate mapping stays near 1:1.
  const resize = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    void setBrowserViewport(Math.round(rect.width), Math.round(rect.height));
  });
  resize.observe(canvas);

  const orphanTimer = window.setInterval(() => {
    if (!canvas.isConnected) disposeBrowserView();
  }, ORPHAN_CHECK_MS);

  active = {
    dispose() {
      unsubscribe();
      resize.disconnect();
      window.clearInterval(orphanTimer);
      detachInput();
    },
  };

  void navigateBrowser(url)
    .then((settled) => {
      reportedUrl = settled;
      onUrl(settled);
    })
    .catch(() => {
      // Navigation failed (bad host, refused connection). Leave the canvas in
      // place — the tab is still usable once the user tries another URL.
    });
}
