import type { BidiConnection } from "./bidi.ts";
import {
  centerScript,
  focusScript,
  REF_PATTERN,
  SNAPSHOT_SCRIPT,
} from "./page-scripts.ts";

/** Page interaction primitives for one Firefox tab (BiDi browsing context), addressed by element ref. */

interface Point {
  x: number;
  y: number;
}

const key = (code: number): string => String.fromCharCode(code);

/** WebDriver's private-use code points for the non-text keys the agent may press. */
export const WD_KEYS: Record<string, string> = {
  Enter: key(0xe007),
  Tab: key(0xe004),
  Escape: key(0xe00c),
  Backspace: key(0xe003),
  Delete: key(0xe017),
  ArrowUp: key(0xe013),
  ArrowDown: key(0xe015),
  ArrowLeft: key(0xe012),
  ArrowRight: key(0xe014),
  Home: key(0xe011),
  End: key(0xe010),
  PageUp: key(0xe00e),
  PageDown: key(0xe00f),
  Shift: key(0xe008),
  Control: key(0xe009),
  Alt: key(0xe00a),
  Meta: key(0xe03d),
};

const PRESSABLE = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

/** Run a script in a tab and return its value; `expression` must evaluate to something JSON-able. */
export async function evalJson<T>(
  bidi: BidiConnection,
  context: string,
  expression: string,
): Promise<T> {
  const reply = await bidi.send<{
    type: string;
    result?: { type: string; value?: string };
    exceptionDetails?: { text: string };
  }>("script.evaluate", {
    expression: `JSON.stringify(${expression})`,
    target: { context },
    awaitPromise: false,
  });
  if (reply.type !== "success") {
    throw new Error(reply.exceptionDetails?.text ?? "script failed");
  }
  const text = reply.result?.value;
  return (text === undefined ? undefined : JSON.parse(text)) as T;
}

function checkRef(ref: string): string {
  if (!REF_PATTERN.test(ref)) throw new Error(`invalid ref: ${ref}`);
  return ref;
}

/** Scroll an element into view and return its centre; refs vanish on navigation. */
async function locate(
  bidi: BidiConnection,
  context: string,
  ref: string,
): Promise<Point> {
  const point = await evalJson<Point | null>(
    bidi,
    context,
    centerScript(checkRef(ref)),
  );
  if (!point) {
    throw new Error(`unknown element ${ref}: call browser_read for fresh refs`);
  }
  return point;
}

type PointerAction =
  | { type: "pointerMove"; x: number; y: number; origin: "viewport" }
  | { type: "pointerDown"; button: number }
  | { type: "pointerUp"; button: number };

const move = (point: Point): PointerAction => ({
  type: "pointerMove",
  x: Math.round(point.x),
  y: Math.round(point.y),
  origin: "viewport",
});

/** Perform a pointer action sequence (the pointer's pressed state persists across calls). */
export function pointer(
  bidi: BidiConnection,
  context: string,
  actions: PointerAction[],
): Promise<unknown> {
  return bidi.send("input.performActions", {
    context,
    actions: [
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions,
      },
    ],
  });
}

/** Press and release each of `values` (WebDriver key values) in order. */
export function keys(
  bidi: BidiConnection,
  context: string,
  values: string[],
): Promise<unknown> {
  return bidi.send("input.performActions", {
    context,
    actions: [
      {
        type: "key",
        id: "keyboard",
        actions: values.flatMap((value) => [
          { type: "keyDown", value },
          { type: "keyUp", value },
        ]),
      },
    ],
  });
}

/** Outline of the visible interactive elements, each tagged with a ref. */
export function snapshot(
  bidi: BidiConnection,
  context: string,
): Promise<string> {
  return evalJson<string>(bidi, context, SNAPSHOT_SCRIPT);
}

export async function hover(
  bidi: BidiConnection,
  context: string,
  ref: string,
): Promise<void> {
  await pointer(bidi, context, [move(await locate(bidi, context, ref))]);
}

export async function click(
  bidi: BidiConnection,
  context: string,
  ref: string,
): Promise<void> {
  const point = await locate(bidi, context, ref);
  await pointer(bidi, context, [
    move(point),
    { type: "pointerDown", button: 0 },
    { type: "pointerUp", button: 0 },
  ]);
}

export async function drag(
  bidi: BidiConnection,
  context: string,
  fromRef: string,
  toRef: string,
): Promise<void> {
  const from = await locate(bidi, context, fromRef);
  const to = await locate(bidi, context, toRef);
  const steps = 8;
  const path: PointerAction[] = [
    move(from),
    { type: "pointerDown", button: 0 },
  ];
  for (let i = 1; i <= steps; i++) {
    path.push(
      move({
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
      }),
    );
  }
  path.push({ type: "pointerUp", button: 0 });
  await pointer(bidi, context, path);
}

export interface TypeOptions {
  /** Select the element's existing contents first so the text replaces them. */
  replace: boolean;
  /** A key from the pressable set to press after the text. */
  key?: string;
}

/** Focus `ref` (when given), type `text`, then optionally press a key. */
export async function typeText(
  bidi: BidiConnection,
  context: string,
  ref: string | undefined,
  text: string,
  options: TypeOptions,
): Promise<void> {
  const pressed = options.key ? WD_KEYS[options.key] : undefined;
  if (options.key && (!pressed || !PRESSABLE.includes(options.key))) {
    throw new Error(
      `unsupported key ${options.key}; use one of ${PRESSABLE.join(", ")}`,
    );
  }
  if (ref !== undefined) {
    const ok = await evalJson<boolean>(
      bidi,
      context,
      focusScript(checkRef(ref), options.replace),
    );
    if (!ok) {
      throw new Error(
        `unknown element ${ref}: call browser_read for fresh refs`,
      );
    }
  }
  // A newline in the text is the Enter key; every other character types itself.
  const typed = [...text].map((c) => (c === "\n" ? WD_KEYS["Enter"]! : c));
  if (pressed) typed.push(pressed);
  if (typed.length > 0) await keys(bidi, context, typed);
}
