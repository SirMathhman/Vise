import type { CdpConnection } from "./cdp.ts";
import type { BrowserInput, FrameListener } from "./types.ts";

/** Live view and input forwarding for one attached tab (CDP session). */

const MOUSE_TYPES = {
  move: "mouseMoved",
  down: "mousePressed",
  up: "mouseReleased",
  wheel: "mouseWheel",
} as const;

/**
 * Resize the tab's viewport and stream JPEG frames of it. Each frame must be
 * acknowledged or Chromium stops sending, so the ack happens here.
 */
export async function startScreencast(
  cdp: CdpConnection,
  sessionId: string,
  width: number,
  height: number,
  onFrame: FrameListener,
): Promise<() => Promise<void>> {
  await cdp.send(
    "Emulation.setDeviceMetricsOverride",
    { width, height, deviceScaleFactor: 1, mobile: false },
    sessionId,
  );
  const off = cdp.on("Page.screencastFrame", (params, session) => {
    if (session !== sessionId) return;
    onFrame(String(params["data"]));
    void cdp
      .send(
        "Page.screencastFrameAck",
        { sessionId: params["sessionId"] },
        sessionId,
      )
      .catch(() => undefined);
  });
  await cdp.send(
    "Page.startScreencast",
    { format: "jpeg", quality: 60, maxWidth: width, maxHeight: height },
    sessionId,
  );
  return async () => {
    off();
    await cdp.send("Page.stopScreencast", {}, sessionId).catch(() => undefined);
  };
}

/** Translate a neutral input event into the matching CDP `Input.*` call. */
export async function dispatchInput(
  cdp: CdpConnection,
  sessionId: string,
  input: BrowserInput,
): Promise<void> {
  if (input.kind === "mouse") {
    await cdp.send(
      "Input.dispatchMouseEvent",
      {
        type: MOUSE_TYPES[input.type],
        x: input.x,
        y: input.y,
        button: input.button,
        clickCount: input.clickCount,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers,
      },
      sessionId,
    );
    return;
  }
  await cdp.send(
    "Input.dispatchKeyEvent",
    {
      type: input.type === "down" ? "keyDown" : "keyUp",
      key: input.key,
      code: input.code,
      windowsVirtualKeyCode: input.keyCode,
      text: input.type === "down" ? input.text : undefined,
      modifiers: input.modifiers,
    },
    sessionId,
  );
}
