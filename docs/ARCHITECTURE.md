# Vise — Architecture

## Definitions

- **Vise**: a terminal user interface (TUI) application built on ratatui + crossterm.
- **App state**: the single owned value (`App`) describing everything the UI displays and all mutable state (screen stack, buffers, configuration).
- **Frame tick**: one iteration of the main loop — process pending events, then render once.
- **Screen**: a self-contained rendered view identified by a variant; screens compose via ratatui `Layout` and own no global state of their own.
- **Invariant**: terminal I/O is confined to a single module (`app.rs`); every other module is pure of terminal setup and therefore unit-testable without a real TTY.

## Structure

```
vise/
  src/
    lib.rs          # pub mod {app, state, event, ui, llm}; re-exports run
    main.rs         # thin binary shell: tokio runtime, color_eyre, calls vise::run()
    app.rs          # pub async fn run() — terminal setup + event-loop orchestration only
    state.rs        # App: all mutable state; transitions as methods; NO terminal, NO tokio
    event.rs        # crossterm reader task + Event → mpsc forwarding
    ui.rs           # render(&App, &mut Frame); read-only &App; NO terminal setup
    llm.rs          # reqwest streaming client for the local llama.cpp OpenAI endpoint
```

Dependency direction (lib only): `main → app` (single entry, `vise::run`); `app → {state, event, ui, llm}`; `ui → state` (read-only `&App`); `state`, `event`, and `llm` have no internal deps of one another. No cycles: `ui`, `state`, `event`, and `llm` are leaves; only `app` composes them.

### Streaming model

The event loop is async on a multi-thread tokio runtime. The blocking crossterm reader runs on `spawn_blocking` and forwards `Event`s over an `unbounded` channel; the streaming request runs on `tokio::spawn` and forwards tokens over a bounded `mpsc`. The main loop drains tokens via `mpsc::Receiver::recv`. This is intentionally select-free: there is no `tokio::select!`, so each concern (input, stream, render) owns exactly one channel edge and there is no cross-wake coupling.

## Potential Problems

- **Terminal ownership in the library**: `lib.rs` currently owns `ratatui::try_init`, `terminal.draw`, and the whole event loop, which violates the invariant that the lib be pure of terminal setup. The fix is the module split above: only `app.rs` touches the terminal; `state`, `event`, `ui`, and `llm` must be terminal-free and unit-testable without a TTY.
- **Blocking event reads**: the crossterm reader is isolated on `spawn_blocking`, so the async loop is not blocked by I/O. A frame cadence is still not enforced; add `event::poll(timeout)` / a `Tick` event when a steady redraw rate or resize handling becomes a requirement.
- **State duplication**: render fns must take `&App` by reference and never cache copies of `App` fields; stale local state is a class of bug, not a feature.
- **Error surface**: `llm.rs` returns `Result<(), String>` today. Introduce a `ViseError` enum (implementing `std::error::Error`) as domain errors grow; each variant must answer what/where/why/fix. Start by converting the `llm` request/stream errors so the `app` layer can match on a structured type instead of strings.
- **Terminal restore**: any panic in the event loop must still restore the terminal — `ratatui::restore()` runs after the loop returns; do not re-init the terminal in lib code paths other than `app.rs`.
- **Module growth**: keep `ui` under 10 files; a screen/module over ~500 lines splits into submodules.

## Future Work

- **Split `lib.rs`** (immediate, no behavior change): move `App` + `Message` into `state.rs`, the crossterm reader into `event.rs`, `render` into `ui.rs`, and `run`/`app_loop`/`drain_tokens` into `app.rs`. This is the single highest-value change and the prerequisite for everything below.
- Add an offscreen-terminal test harness (ratatui `TestBackend`) so `ui.rs` render fns are unit-tested without a TTY. This is only possible once `ui` no longer owns terminal setup.
- Add a `ViseError` enum as domain errors appear; keep `color_eyre` for reporting only.
- Replace blocking `event::read()` with `event::poll(Duration)` + a `Tick` event once a steady frame cadence is needed.
- Generalize `App` from a single `message: Option<Message>` to a message list when multi-turn conversation is introduced; the current single-message design is a deliberate early-stage choice.
- CI: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`.

## Performance

- The draw loop should target a sane frame cadence (tens of ms), not block on I/O; measure with a profiler before optimizing any render path.
- `opt-level="s"` + `lto=true` is the right release tradeoff for a TUI; do not raise `opt-level` until a profiler says so.
- Full-frame redraws are fine at this scale; switch to diffed/incremental rendering only if a profile shows `terminal.draw` dominating.
