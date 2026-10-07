import type { CdpConnection } from "./cdp.ts";
import {
  centerScript,
  FILE_INPUT_SELECTOR,
  fileInputProblem,
  fileInputScript,
  focusScript,
  selectedOrThrow,
  selectScript,
  REF_PATTERN,
  SNAPSHOT_SCRIPT,
} from "./page-scripts.ts";

/** Page interaction primitives for one attached tab (CDP session), addressed by element ref. */

interface Point {
  x: number;
  y: number;
}

/** The few non-text keys the agent may press, with their CDP key and virtual key code. */
const KEYS: Record<string, { code: string; keyCode: number; text: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: String.fromCharCode(13) },
  Tab: { code: "Tab", keyCode: 9, text: "" },
  Escape: { code: "Escape", keyCode: 27, text: "" },
  Backspace: { code: "Backspace", keyCode: 8, text: "" },
  ArrowUp: { code: "ArrowUp", keyCode: 38, text: "" },
  ArrowDown: { code: "ArrowDown", keyCode: 40, text: "" },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37, text: "" },
  ArrowRight: { code: "ArrowRight", keyCode: 39, text: "" },
};

export const PRESSABLE_KEYS = Object.keys(KEYS);

async function evaluate<T>(
  cdp: CdpConnection,
  sessionId: string,
  expression: string,
): Promise<T> {
  const { result, exceptionDetails } = await cdp.send<{
    result: { value?: T };
    exceptionDetails?: { text: string };
  }>("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  if (exceptionDetails) throw new Error(exceptionDetails.text);
  return result.value as T;
}

function checkRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) throw new Error(`invalid ref: ${ref}`);
  return ref;
}

/** Scroll an element into view and return its centre; refs vanish on navigation. */
async function locate(
  cdp: CdpConnection,
  sessionId: string,
  ref: string,
): Promise<Point> {
  const point = await evaluate<Point | null>(
    cdp,
    sessionId,
    centerScript(checkRef(ref)),
  );
  if (!point) {
    throw new Error(`unknown element ${ref}: call browser_read for fresh refs`);
  }
  return point;
}

function mouse(
  cdp: CdpConnection,
  sessionId: string,
  type: "mouseMoved" | "mousePressed" | "mouseReleased",
  point: Point,
  pressed: boolean,
): Promise<unknown> {
  return cdp.send(
    "Input.dispatchMouseEvent",
    {
      type,
      ...point,
      button: type === "mouseMoved" && !pressed ? "none" : "left",
      buttons: pressed ? 1 : 0,
      clickCount: type === "mouseMoved" ? 0 : 1,
    },
    sessionId,
  );
}

/** Outline of the visible interactive elements, each tagged with a ref. */
export function snapshot(
  cdp: CdpConnection,
  sessionId: string,
): Promise<string> {
  return evaluate<string>(cdp, sessionId, SNAPSHOT_SCRIPT);
}

/** Put files into the file input behind `ref` (the browser reads them from disk). */
export async function uploadFiles(
  cdp: CdpConnection,
  sessionId: string,
  ref: string,
  paths: string[],
): Promise<void> {
  const status = await evaluate<string>(
    cdp,
    sessionId,
    fileInputScript(checkRef(ref)),
  );
  const problem = fileInputProblem(status, ref, paths.length);
  if (problem) throw new Error(problem);
  const { result } = await cdp.send<{ result: { objectId?: string } }>(
    "Runtime.evaluate",
    {
      expression: `document.querySelector(${JSON.stringify(FILE_INPUT_SELECTOR)})`,
    },
    sessionId,
  );
  if (!result.objectId) throw new Error("the file input disappeared");
  await cdp.send(
    "DOM.setFileInputFiles",
    { files: paths, objectId: result.objectId },
    sessionId,
  );
}

/** Choose options of the `<select>` behind `ref`. */
export async function selectOption(
  cdp: CdpConnection,
  sessionId: string,
  ref: string,
  wanted: string[],
): Promise<string[]> {
  const result = await evaluate<Parameters<typeof selectedOrThrow>[1]>(
    cdp,
    sessionId,
    selectScript(checkRef(ref), wanted),
  );
  return selectedOrThrow(ref, result);
}

export async function hover(
  cdp: CdpConnection,
  sessionId: string,
  ref: string,
): Promise<void> {
  const point = await locate(cdp, sessionId, ref);
  await mouse(cdp, sessionId, "mouseMoved", point, false);
}

export async function click(
  cdp: CdpConnection,
  sessionId: string,
  ref: string,
): Promise<void> {
  const point = await locate(cdp, sessionId, ref);
  await mouse(cdp, sessionId, "mouseMoved", point, false);
  await mouse(cdp, sessionId, "mousePressed", point, true);
  await mouse(cdp, sessionId, "mouseReleased", point, false);
}

export async function drag(
  cdp: CdpConnection,
  sessionId: string,
  fromRef: string,
  toRef: string,
): Promise<void> {
  const from = await locate(cdp, sessionId, fromRef);
  const to = await locate(cdp, sessionId, toRef);
  await mouse(cdp, sessionId, "mouseMoved", from, false);
  await mouse(cdp, sessionId, "mousePressed", from, true);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const point = {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    };
    await mouse(cdp, sessionId, "mouseMoved", point, true);
  }
  await mouse(cdp, sessionId, "mouseReleased", to, false);
}

export interface TypeOptions {
  /** Select the element's existing contents first so the text replaces them. */
  replace: boolean;
  /** A key from `PRESSABLE_KEYS` to press after the text. */
  key?: string;
}

/** Focus `ref` (when given), type `text`, then optionally press a key. */
export async function typeText(
  cdp: CdpConnection,
  sessionId: string,
  ref: string | undefined,
  text: string,
  options: TypeOptions,
): Promise<void> {
  if (ref !== undefined) {
    const ok = await evaluate<boolean>(
      cdp,
      sessionId,
      focusScript(checkRef(ref), options.replace),
    );
    if (!ok) {
      throw new Error(
        `unknown element ${ref}: call browser_read for fresh refs`,
      );
    }
  }
  if (text) await cdp.send("Input.insertText", { text }, sessionId);
  const key = options.key ? KEYS[options.key] : undefined;
  if (options.key && !key) {
    throw new Error(
      `unsupported key ${options.key}; use one of ${PRESSABLE_KEYS.join(", ")}`,
    );
  }
  if (key && options.key) {
    for (const type of ["keyDown", "keyUp"] as const) {
      await cdp.send(
        "Input.dispatchKeyEvent",
        {
          type,
          key: options.key,
          code: key.code,
          windowsVirtualKeyCode: key.keyCode,
          text: type === "keyDown" ? key.text : undefined,
        },
        sessionId,
      );
    }
  }
}
