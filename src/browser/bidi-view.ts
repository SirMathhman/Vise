import { config } from "../config.ts";
import type { BidiConnection } from "./bidi.ts";
import { WD_KEYS } from "./bidi-actions.ts";
import type { BrowserInput, FrameListener } from "./types.ts";

/** Live view and input forwarding for one Firefox tab (BiDi browsing context). */

/** Pause between screenshots; BiDi has no screencast, so the view polls. */

const BUTTONS = { left: 0, middle: 1, right: 2, none: 0 } as const;

/**
 * Resize the tab's viewport and poll JPEG screenshots of it. A capture is
 * never started while the previous one is in flight, so a slow page lowers
 * the frame rate instead of piling up requests.
 */
export async function startScreencast(
  bidi: BidiConnection,
  context: string,
  width: number,
  height: number,
  onFrame: FrameListener,
): Promise<() => Promise<void>> {
  await bidi.send("browsingContext.setViewport", {
    context,
    viewport: { width, height },
    devicePixelRatio: 1,
  });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capture = async (): Promise<void> => {
    try {
      const { data } = await bidi.send<{ data: string }>(
        "browsingContext.captureScreenshot",
        {
          context,
          origin: "viewport",
          format: { type: "image/jpeg", quality: 0.6 },
        },
      );
      if (!stopped) onFrame(data);
    } catch {
      // the tab is navigating or gone; try again on the next tick
    }
    if (!stopped) timer = setTimeout(() => void capture(), config.liveViewFrameMs);
  };
  void capture();
  return async () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** The WebDriver key value for a DOM `key`, or undefined when it has none. */
function keyValue(key: string): string | undefined {
  if (key.length === 1 || [...key].length === 1) return key;
  return WD_KEYS[key];
}

/** Translate a neutral input event into a BiDi `input.performActions` call. */
export async function dispatchInput(
  bidi: BidiConnection,
  context: string,
  input: BrowserInput,
): Promise<void> {
  if (input.kind === "mouse") {
    const x = Math.round(input.x);
    const y = Math.round(input.y);
    if (input.type === "wheel") {
      await bidi.send("input.performActions", {
        context,
        actions: [
          {
            type: "wheel",
            id: "wheel",
            actions: [
              {
                type: "scroll",
                x,
                y,
                deltaX: Math.round(input.deltaX),
                deltaY: Math.round(input.deltaY),
                origin: "viewport",
              },
            ],
          },
        ],
      });
      return;
    }
    const button = BUTTONS[input.button];
    const action =
      input.type === "move"
        ? { type: "pointerMove", x, y, origin: "viewport" }
        : { type: input.type === "down" ? "pointerDown" : "pointerUp", button };
    await bidi.send("input.performActions", {
      context,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [action],
        },
      ],
    });
    return;
  }
  const value = keyValue(input.key);
  if (value === undefined) return;
  await bidi.send("input.performActions", {
    context,
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: [{ type: input.type === "down" ? "keyDown" : "keyUp", value }],
      },
    ],
  });
}
