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
