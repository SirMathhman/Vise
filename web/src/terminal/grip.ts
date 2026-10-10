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
