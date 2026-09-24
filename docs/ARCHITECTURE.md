# Vise — Architecture

## Definitions

- **Vise**: a terminal user interface (TUI) application built on ratatui + crossterm.
- **App state**: the single owned value (`App`) describing everything the UI displays and all mutable state (screen stack, buffers, configuration).
- **Frame tick**: one iteration of the main loop — process pending events, then render once.
- **Screen**: a self-contained rendered view identified by a variant; screens compose via ratatui `Layout` and own no global state of their own.
- **Invariant**: all terminal I/O happens inside the `ratatui::run` closure; the lib is pure of terminal setup and therefore unit-testable without a real TTY.

## Structure

```
vise/
  src/
    lib.rs          # pub mod {app, state, event, ui}; re-exports App
    main.rs         # thin binary shell: color_eyre install, ratatui::run(vise::app)
    app.rs          # fn app(terminal) — main loop only
    state.rs        # App: screen stack + all mutable state; transitions as methods
    event.rs        # Event enum (Key, Resize, Tick, Quit) + crossterm::event::poll mapping
    ui/
      mod.rs        # render(&App, &mut Frame) dispatching on current screen
      screen_x.rs   # one file per screen, each a pure fn(&App, area, buf)
```

Dependency direction (lib only): `main → {app, state, event, ui}`; `ui → state` (read-only `&App`); `app → {state, event, ui}`; `state` and `event` have no internal deps. No cycles: screens depend on `state` by reference only, never the other way around.

## Potential Problems

- **Blocking event reads**: `crossterm::event::read()` blocks the loop indefinitely; switch to `event::poll(timeout)` with a short timeout so a target frame cadence and resize handling stay responsive.
- **State duplication**: screens must not cache copies of `App` fields; render fns take `&App` by reference, so stale local state is a class of bug, not a feature.
- **Error surface**: once domain errors exist, a `ViseError` enum (implementing `std::error::Error`) replaces raw `io::Error` strings; each variant must answer what/where/why/fix.
- **Terminal restore**: any panic inside the `ratatui::run` closure must still restore the terminal — `ratatui::run` handles this; do not re-init the terminal in lib code paths.
- **Module growth**: keep `ui/` under 10 files/directory; a screen file over ~500 lines splits into `screen_x/subwidget.rs` files.

## Future Work

- Move `app`/`render` out of `main.rs` into the lib (immediate).
- Introduce `App` state struct with explicit screen-transition methods; loop calls `app.tick(&mut app)` then `ui::render(&app, frame)`.
- Replace blocking `event::read()` with `event::poll(Duration)` and a `Tick` event.
- Add an offscreen-terminal test harness (ratatui `TestBackend`) so render fns are unit-tested without a TTY.
- Add `ViseError` enum as domain errors appear; keep `color_eyre` for reporting only.
- CI: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.

## Performance

- The draw loop should target a sane frame cadence (tens of ms), not block on I/O; measure with a profiler before optimizing any render path.
- `opt-level="s"` + `lto=true` is the right release tradeoff for a TUI; do not raise `opt-level` until a profiler says so.
- Full-frame redraws are fine at this scale; switch to diffed/incremental rendering only if a profile shows `terminal.draw` dominating.
