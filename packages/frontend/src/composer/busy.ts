/** Why the composer is locked. */
export interface BusyState {
  /** A line is running on the server (the `state` message is the only thing that sets this and `steerable`). */
  server: boolean;
  /** The running line is a turn the user can steer, not a command. */
  steerable: boolean;
  /** A line was just sent and the server has not answered yet. */
  submitting: boolean;
  /** The page is loading its lists at start-up. */
  loading: boolean;
}

/** What the controls should look like for a state. */
export interface BusyView {
  busy: boolean;
  /** The composer stays usable while a turn runs: steer it or queue behind it. */
  steering: boolean;
}

export function busyView(state: BusyState): BusyView {
  return {
    busy: state.server || state.submitting || state.loading,
    steering: state.server && state.steerable,
  };
}

/**
 * The composer's locked/unlocked state. The server says whether a line is
 * running; the page adds only what it knows itself: a line it has just sent
 * (until the server answers) and its lists loading. Every control is set from
 * one `render`, so no caller has to pair an "on" with a later "off".
 */
export function createBusy(controls: {
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  /** Controls that are locked whenever anything is running (selects, new, burst). */
  locked: (HTMLButtonElement | HTMLSelectElement)[];
  setSteering: (on: boolean) => void;
  hideSuggestions: () => void;
  /** Told after every change whether a line is running (the status pill follows). */
  onRunning?: (running: boolean) => void;
}): {
  state: BusyState;
  isBusy(): boolean;
  render(): void;
  endLoading(): void;
  reset(): void;
} {
  const state: BusyState = {
    server: false,
    steerable: false,
    submitting: false,
    loading: false,
  };
  function render(): void {
    const view = busyView(state);
    if (view.busy) controls.hideSuggestions();
    controls.setSteering(view.steering);
    controls.input.disabled = view.busy && !view.steering;
    controls.send.disabled = view.busy;
    controls.send.classList.toggle("hidden", view.steering);
    // Stop is for work the user started, not for the page loading its lists.
    controls.stop.classList.toggle("hidden", !(state.server || state.submitting));
    for (const control of controls.locked) control.disabled = view.busy;
    controls.onRunning?.(state.server || state.submitting);
  }
  return {
    state,
    isBusy: () => busyView(state).busy,
    render,
    endLoading() {
      state.loading = false;
      render();
    },
    reset() {
      Object.assign(state, {
        server: false,
        steerable: false,
        submitting: false,
        loading: false,
      });
      render();
    },
  };
}
