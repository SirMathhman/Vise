# vise-gui Architecture

`vise-gui` is the window frontend, package `vise-gui`: egui drawn on wgpu through `eframe`.
It talks to the engine over channels, because the provider and the tool runner are not `Sync`.

## Structure

```
src/
  main.rs            wiring: reads .env and LLAMA_API_KEY, takes the working directory, creates the `Stop`, chooses the low-power
                     wgpu adapter (`WGPU_POWER_PREF` overrides it), and opens the window. `--resume` continues the last session;
                     the default is a fresh one, because the window cannot show the history of a resumed session.
  worker.rs          the thread that owns the engine, built there because the provider and the tool runner are not `Sync`:
                     `Worker` (the window's handle: `send`, `answer`, `poll`, `close`, `join`), `Message` (`Event`, `Approval`,
                     `Handled`, `Exited`), and `ChannelFrontend`, whose `approve` sends the question and blocks until answered
  transcript.rs      `Transcript`: turns `UiEvent`s into display items (user, streamed answer, tool lines with a nested flag,
                     notices, errors) and a progress value for the status strip. No egui types.
  words.rs           the English wording of the typed query results and changes, the same as the terminal's
  app.rs             `ViseApp`: the status strip, the scrolling transcript, the input box with Send and Stop, and the approval dialog;
                     it sends `Request`s to the worker and draws what the worker reports
```

## Invariants

### The worker thread

- The worker thread owns the engine, built there because the provider and the tool runner are not `Sync`.
- `Worker` is the window's handle: `send`, `answer`, `poll`, `close`, `join`.
- `Message` is the channel type: `Event`, `Approval`, `Handled`, `Exited`.
- `ChannelFrontend`'s `approve` sends the question and blocks until answered.

### Display

- `Transcript` turns `UiEvent`s into display items (user, streamed answer, tool lines with a nested flag,
  notices, errors) and a progress value for the status strip. No egui types.
- `words.rs` provides the English wording of the typed query results and changes, the same as the terminal's.
- `ViseApp` draws the status strip, the scrolling transcript, the input box with Send and Stop, and the approval dialog.

## Dependencies

An arrow means "may depend on". Dependencies only point one way; there are no cycles.

```
vise-gui -> vise-core (its public modules only), eframe (egui, egui-wgpu, egui-winit, wgpu, winit)
  main -> app, worker, vise_core::{environment, parts, stop}
  app -> transcript, worker, vise_core::{engine, command, slash, stop, frontend}
  worker -> vise_core::{engine, frontend, parts, stop}
  transcript -> words, vise_core::{frontend, provider::types}
  words -> vise_core::frontend
```

## Open Problems

### The frontend boundary

- **The window cannot show a resumed session.** The engine sends no event for the messages already in the history, so `--resume`
  starts with an empty transcript while the model has the whole context; the window therefore starts fresh by default. A
  `History` event (or a read-only `Engine::history`) would fix it.
- **The worker thread has no failure path of its own.** `Worker` reports a dead thread as `Poll::Gone`, but the panic payload is lost
  to stderr (a window has none), and the shutdown step and the last autosave never run, so a crash costs everything since the
  previous save. The thread body should run under `catch_unwind`, send the payload as an `Error`, and still attempt `shutdown`.
  Closing the window joins the thread on the UI thread, so a tool that ignores `Stop` freezes the exit; the join needs a deadline
  after which the process ends anyway.
- **A blocked approval does not observe `Stop`.** `ChannelFrontend::approve` waits on a plain `recv`. The window's modal hides the
  Stop button, so today only closing the window (which drops the answer channel and counts as No) can end the wait, but any
  frontend that can press Stop while a question is open leaves the engine blocked with the stop flag set. `approve` should wait on
  the answer or the stop, and a stop is a No. Answers are bare `bool`s with no id, so a late answer to an earlier question would be
  taken for the next one; with `Approval { id }` the worker discards answers whose id is not the open question's.
- **No test drives the window against the worker.** The worker, the transcript and one frame are tested apart; a streamed answer
  that raises an approval and is answered through the modal is not. A harness that feeds `egui_kittest` input to `ViseApp` over a
  scripted worker would cover the flow that a person cannot script.
