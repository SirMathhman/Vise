/**
 * Draggable vertical dividers between the three main panels (listing / viewer /
 * llm). A thin DOM controller, in the same shape as `fileTree.ts` / `llm.ts`:
 * it only wires DOM events and never owns app state.
 *
 * Strategy: the flex layout in `panel.css` already sizes the three panels in
 * the intended ratio before any JS runs. On init we *freeze* the rendered
 * widths of the listing and viewer panels by writing `flex: 0 0 <px>` inline
 * (measured from `getBoundingClientRect`, so there is no layout jump). The llm
 * panel keeps its CSS `flex: 1.3 0 0` and simply grows to fill whatever space
 * is left — which is also why window resizes need no code here: the llm panel
 * auto-fills, and we never touch it. Dragging divider 1 trades space between
 * listing and viewer (llm untouched); dragging divider 2 trades space between
 * viewer and llm (the llm's flex-grow absorbs it). Min/max clamps keep every
 * panel above a usable floor.
 */

/**
 * Minimum width any panel may be dragged to. Must equal the CSS `min-width`
 * on `#viewer` / `#llm` in `panel.css` so the JS floor and the CSS floor are
 * the same value and can't drift apart (the CSS `min-width` is the binding
 * constraint either way).
 */
const MIN_PX = 200;
/** Pixel step for a single keyboard nudge (arrow key). */
const STEP_PX = 24;
/** Pixel step for a keyboard nudge with Shift held. */
const STEP_PX_LARGE = 96;
/** Width of each divider track, in CSS pixels (must match `panel.css`). */
const DIVIDER_PX = 20;

/**
 * Marks a divider element that has already been wired. Under Vite HMR the
 * module re-evaluates and `setupPanelDividers` re-runs against the *same*
 * live DOM (the elements are not torn down), so without this guard each reload
 * would stack another full set of pointer listeners onto the divider and a
 * single drag would fire N times. Checking this flag makes the binding
 * idempotent.
 */
const BOUND = Symbol("panel-divider-bound");

export function setupPanelDividers(root: HTMLElement): void {
  const layout = root.querySelector<HTMLElement>(".layout");
  const listing = root.querySelector<HTMLElement>("#listing");
  const viewer = root.querySelector<HTMLElement>("#viewer");
  const divider1 = root.querySelector<HTMLElement>("#divider-1");
  const divider2 = root.querySelector<HTMLElement>("#divider-2");
  if (!layout || !listing || !viewer || !divider1 || !divider2) return;

  /**
   * Live available width for the three panels: the layout's width minus the
   * two 20px divider tracks *and* the four 20px flex `gap`s between the five
   * flex children (listing, divider-1, viewer, divider-2, llm). Reading it
   * each call keeps the mode-2 upper bound correct through window resizes —
   * the llm panel's flex-grow changes the available space, so a value
   * captured once at init would go stale. Forgetting the gaps (the original
   // `layout width - 2 * DIVIDER_PX`) overcounts by 80px and lets the flex
   // row overflow at the mode-2 limit.
   */
  const freeSpace = (): number =>
    layout.getBoundingClientRect().width - 2 * DIVIDER_PX - 4 * 20; // four flex gaps at `gap: 20px` in `panel.css`

  /** Freeze a panel's rendered width into a `flex: 0 0 <px>` inline rule. */
  const freeze = (el: HTMLElement, w: number): void => {
    el.style.flex = `0 0 ${Math.max(MIN_PX, Math.round(w))}px`;
  };

  // The listing and viewer widths we currently consider authoritative. The llm
  // panel's width is never tracked — it is always `freeSpace() - listing - viewer`.
  let listingW = Math.max(
    MIN_PX,
    Math.round(listing.getBoundingClientRect().width)
  );
  let viewerW = Math.max(
    MIN_PX,
    Math.round(viewer.getBoundingClientRect().width)
  );

  const apply = (): void => {
    freeze(listing, listingW);
    freeze(viewer, viewerW);
  };

  /**
   * The allowed range of the divider's *delta* (rightward = positive), relative
   * to the starting widths, such that no panel drops below MIN_PX.
   */
  const bounds = (
    mode: 1 | 2,
    startListing: number,
    startViewer: number
  ): [number, number] => {
    if (mode === 1) {
      // Listing + viewer total is constant during this drag (llm untouched),
      // so the only constraints are each panel's own floor. The lower bound is
      // negative (the listing may shrink toward its floor), the upper bound
      // positive (the viewer may grow until the listing hits its floor).
      return [MIN_PX - startListing, startViewer - MIN_PX];
    }
    // Viewer changes; the llm (flex: 1 1 0) must stay >= MIN_PX too. The
    // upper bound caps the viewer so the flex row can't overflow — the llm
    // panel's CSS min-width would clip it otherwise.
    const maxViewer = freeSpace() - startListing - MIN_PX;
    return [MIN_PX - startViewer, maxViewer - startViewer];
  };

  const bind = (divider: HTMLElement, mode: 1 | 2): void => {
    const d = divider as HTMLElement & { [BOUND]?: boolean };
    if (d[BOUND]) return;
    d[BOUND] = true;

    let dragging = false;
    let startX = 0;
    let startListing = 0;
    let startViewer = 0;

    const onPointerDown = (e: PointerEvent): void => {
      dragging = true;
      startX = e.clientX;
      startListing = listingW;
      startViewer = viewerW;
      divider.classList.add("active");
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e: PointerEvent): void => {
      if (!dragging) return;
      const d = e.clientX - startX;
      const [lo, hi] = bounds(mode, startListing, startViewer);
      const dd = Math.min(Math.max(d, lo), hi);
      if (mode === 1) {
        listingW = startListing + dd;
        viewerW = startViewer - dd;
      } else {
        viewerW = startViewer + dd;
      }
      apply();
    };

    const onPointerEnd = (e: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove("active");
      try {
        divider.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer already released */
      }
    };

    divider.addEventListener("pointerdown", onPointerDown);
    divider.addEventListener("pointermove", onPointerMove);
    divider.addEventListener("pointerup", onPointerEnd);
    divider.addEventListener("pointercancel", onPointerEnd);

    // Keyboard: arrow keys nudge, Shift for a larger step, Home/End snap to the
    // min/max of the current range.
    divider.addEventListener("keydown", (e: KeyboardEvent): void => {
      let dd: number | null = null;
      if (e.key === "ArrowLeft") dd = e.shiftKey ? -STEP_PX_LARGE : -STEP_PX;
      else if (e.key === "ArrowRight")
        dd = e.shiftKey ? STEP_PX_LARGE : STEP_PX;
      else if (e.key === "Home" || e.key === "End") {
        const [lo, hi] = bounds(mode, listingW, viewerW);
        dd = e.key === "Home" ? lo : hi;
      }
      if (dd === null) return;
      const [lo, hi] = bounds(mode, listingW, viewerW);
      const c = Math.min(Math.max(dd, lo), hi);
      if (mode === 1) {
        listingW += c;
        viewerW -= c;
      } else {
        viewerW += c;
      }
      apply();
      e.preventDefault();
    });
  };

  // Freeze the CSS-proportioned widths the browser just laid out into pixel
  // values. Reading the rendered widths (not recomputing from the ratio)
  // means handover to pixel control is seamless — no jump.
  apply();
  bind(divider1, 1);
  bind(divider2, 2);
}
