/**
 * Live view of an integrated-browser tab: shows the screencast frames the
 * server streams and forwards the user's mouse and keyboard back to the page.
 * Frame coordinates map to page CSS pixels because the server sizes the
 * browser viewport to match this pane.
 */

export interface BrowserView {
  /** Start streaming `tab` into the pane (replacing any current view). */
  show(tab: number): void;
  /** Stop streaming and clear the pane. */
  hide(): void;
  /** Navigate `tab` to `url` in the real browser. */
  navigate(tab: number, url: string): void;
  /** Close `tab` in the real browser. */
  close(tab: number): void;
  /** Paint a frame the server sent. */
  frame(tab: number, data: string): void;
}

type Send = (msg: Record<string, unknown>) => void;

const RESIZE_DEBOUNCE_MS = 250;
const MOVE_THROTTLE_MS = 30;
/** The text a CDP Enter key press carries (carriage return). */
const ENTER = String.fromCharCode(13);
const BUTTONS = ["left", "middle", "right"] as const;

function modifiers(e: MouseEvent | KeyboardEvent): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** What the input binders need from the view: the watched tab, the viewport size, the socket. */
interface InputContext {
  tab(): number | null;
  size(): { width: number; height: number };
  send: Send;
}

function bindMouse(pane: HTMLElement, img: HTMLImageElement, ctx: InputContext): void {
  /** Page-pixel position of a pointer event over the frame. */
  const point = (e: MouseEvent): { x: number; y: number } => {
    const box = img.getBoundingClientRect();
    const size = ctx.size();
    return {
      x: ((e.clientX - box.left) * size.width) / (box.width || 1),
      y: ((e.clientY - box.top) * size.height) / (box.height || 1),
    };
  };
  const mouse = (
    type: "move" | "down" | "up" | "wheel",
    e: MouseEvent,
    extra: { deltaX?: number; deltaY?: number } = {},
  ): void => {
    const tab = ctx.tab();
    if (tab === null) return;
    const button = type === "move" ? "none" : (BUTTONS[e.button] ?? "left");
    ctx.send({
      type: "browser_input",
      tab,
      input: {
        kind: "mouse",
        type,
        ...point(e),
        button,
        clickCount: Math.max(1, e.detail),
        deltaX: extra.deltaX ?? 0,
        deltaY: extra.deltaY ?? 0,
        modifiers: modifiers(e),
      },
    });
  };
  let lastMove = 0;
  img.addEventListener("pointerdown", (e) => {
    pane.focus();
    mouse("down", e);
  });
  img.addEventListener("pointerup", (e) => mouse("up", e));
  img.addEventListener("pointermove", (e) => {
    if (Date.now() - lastMove < MOVE_THROTTLE_MS) return;
    lastMove = Date.now();
    mouse("move", e);
  });
  img.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      mouse("wheel", e, { deltaX: e.deltaX, deltaY: e.deltaY });
    },
    { passive: false },
  );
  img.addEventListener("contextmenu", (e) => e.preventDefault());
  img.addEventListener("dragstart", (e) => e.preventDefault());
}

function bindKeyboard(pane: HTMLElement, ctx: InputContext): void {
  const key = (type: "down" | "up", e: KeyboardEvent): void => {
    const tab = ctx.tab();
    if (tab === null) return;
    e.preventDefault();
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    ctx.send({
      type: "browser_input",
      tab,
      input: {
        kind: "key",
        type,
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        text: printable ? e.key : e.key === "Enter" ? ENTER : "",
        modifiers: modifiers(e),
      },
    });
  };
  pane.addEventListener("keydown", (e) => key("down", e));
  pane.addEventListener("keyup", (e) => key("up", e));
}

export function createBrowserView(
  pane: HTMLElement,
  img: HTMLImageElement,
  send: Send,
): BrowserView {
  let tab: number | null = null;
  let size = { width: 0, height: 0 };
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  const watch = (): void => {
    if (tab === null) return;
    size = { width: pane.clientWidth, height: pane.clientHeight };
    send({ type: "browser_watch", tab, ...size });
  };

  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(watch, RESIZE_DEBOUNCE_MS);
  }).observe(pane);

  const ctx: InputContext = { tab: () => tab, size: () => size, send };
  bindMouse(pane, img, ctx);
  bindKeyboard(pane, ctx);

  return {
    show(next) {
      if (tab === next) return;
      tab = next;
      img.removeAttribute("src");
      watch();
    },
    hide() {
      if (tab !== null) send({ type: "browser_unwatch" });
      tab = null;
      img.removeAttribute("src");
    },
    navigate: (id, url) => send({ type: "browser_navigate", tab: id, url }),
    close: (id) => send({ type: "browser_close", tab: id }),
    frame(id, data) {
      if (id === tab) img.src = `data:image/jpeg;base64,${data}`;
    },
  };
}
