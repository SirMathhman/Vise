const MIN_HEIGHT = 80;

// Per-browser conveniences only: storage can be missing or throw.
export function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered; nothing else depends on it
  }
}

/** Let the user drag `grip` (the panel's top edge) to resize `panel`; the height is remembered under `key`. */
export function bindResizeGrip(panel: HTMLElement, grip: HTMLElement, key: string): void {
  const height = Number(load(key));
  if (height >= MIN_HEIGHT) panel.style.height = `${height}px`;
  bindGripKeys(grip, { grow: "ArrowUp", shrink: "ArrowDown" }, () => panel.getBoundingClientRect().height, (next) => {
    const clamped = Math.min(window.innerHeight * 0.85, Math.max(MIN_HEIGHT, next));
    panel.style.height = `${clamped}px`;
    save(key, String(Math.round(clamped)));
  });
  grip.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    grip.setPointerCapture(down.pointerId);
    const startY = down.clientY;
    const startHeight = panel.getBoundingClientRect().height;
    const move = (event: PointerEvent): void => {
      const max = window.innerHeight * 0.85;
      const next = Math.min(max, Math.max(MIN_HEIGHT, startHeight + startY - event.clientY));
      panel.style.height = `${next}px`;
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener(
      "pointerup",
      () => {
        grip.removeEventListener("pointermove", move);
        save(key, String(Math.round(panel.getBoundingClientRect().height)));
      },
      { once: true },
    );
  });
}

const MIN_WIDTH = 80;

/** Let the user drag `grip` (the panel's right edge) to resize `panel` horizontally; the width is remembered under `key`. */
export function bindHResizeGrip(panel: HTMLElement, grip: HTMLElement, key: string, minWidth = MIN_WIDTH): void {
  const width = Number(load(key));
  if (width >= minWidth) panel.style.flex = `0 0 ${width}px`;
  bindGripKeys(grip, { grow: "ArrowRight", shrink: "ArrowLeft" }, () => panel.getBoundingClientRect().width, (next) => {
    const max = (panel.parentElement?.getBoundingClientRect().width ?? window.innerWidth) * 0.8;
    const clamped = Math.min(max, Math.max(minWidth, next));
    panel.style.flex = `0 0 ${clamped}px`;
    save(key, String(Math.round(clamped)));
  });
  grip.addEventListener("pointerdown", (down) => {
    down.preventDefault();
    grip.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const move = (event: PointerEvent): void => {
      const max = (panel.parentElement?.getBoundingClientRect().width ?? window.innerWidth) * 0.8;
      const next = Math.min(max, Math.max(minWidth, startWidth + event.clientX - startX));
      panel.style.flex = `0 0 ${next}px`;
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener(
      "pointerup",
      () => {
        grip.removeEventListener("pointermove", move);
        save(key, String(Math.round(panel.getBoundingClientRect().width)));
      },
      { once: true },
    );
  });
}

/** How far one arrow press moves a divider (pixels); Shift moves it further. */
const KEY_STEP = 16;

/**
 * Arrow keys on a focused divider resize its panel by a step (Shift: four):
 * `grow` is the key that makes the panel bigger, `shrink` the one that makes
 * it smaller. `apply` sets and remembers the new size.
 */
export function bindGripKeys(
  grip: HTMLElement,
  keys: { grow: string; shrink: string },
  size: () => number,
  apply: (next: number) => void,
): void {
  grip.addEventListener("keydown", (event) => {
    const sign = event.key === keys.grow ? 1 : event.key === keys.shrink ? -1 : 0;
    if (sign === 0) return;
    event.preventDefault();
    apply(size() + sign * KEY_STEP * (event.shiftKey ? 4 : 1));
  });
}
