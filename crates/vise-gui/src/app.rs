//! The window: a scrolling transcript, a status strip, an input box with a Stop button, and the approval dialog. It holds
//! no engine; it sends `Request`s to the worker and shows what the worker reports.

use crate::transcript::{Item, Progress, Transcript};
use crate::worker::{Message, Poll, Worker};
use eframe::egui::{self, Color32, Key, KeyboardShortcut, Modifiers, RichText};
use vise_core::command::Command;
use vise_core::engine::Request;
use vise_core::slash;
use vise_core::stop::Stop;

const CYAN: Color32 = Color32::from_rgb(86, 182, 194);
const RED: Color32 = Color32::from_rgb(224, 108, 117);
const GREEN: Color32 = Color32::from_rgb(152, 195, 121);
const DIM: Color32 = Color32::from_gray(140);

pub struct ViseApp {
    worker: Worker,
    stop: Stop,
    transcript: Transcript,
    input: String,
    /// A request is running.
    busy: bool,
    /// The worker has ended, so nothing more can be sent.
    ended: bool,
    /// The change the worker is asking about, if any.
    approval: Option<String>,
    /// Put the cursor back in the input box on the next frame.
    focus_input: bool,
}

impl ViseApp {
    pub fn new(worker: Worker, stop: Stop) -> Self {
        Self {
            worker,
            stop,
            transcript: Transcript::default(),
            input: String::new(),
            busy: false,
            ended: false,
            approval: None,
            focus_input: true,
        }
    }

    /// Takes everything the worker has sent.
    fn drain(&mut self) {
        loop {
            match self.worker.poll() {
                Poll::Message(Message::Event(event)) => self.transcript.apply(event),
                Poll::Message(Message::Approval(change)) => self.approval = Some(change),
                Poll::Message(Message::Handled(_)) => {
                    self.busy = false;
                    self.transcript.finish();
                    self.focus_input = true;
                }
                Poll::Message(Message::Exited) => self.end(),
                Poll::Empty => return,
                Poll::Gone => {
                    if !self.ended {
                        self.transcript.apply(vise_core::frontend::UiEvent::Error(
                            "the session stopped unexpectedly".to_string(),
                        ));
                    }
                    return self.end();
                }
            }
        }
    }

    fn end(&mut self) {
        self.ended = true;
        self.busy = false;
        self.approval = None;
    }

    /// Sends what is in the input box: a slash command, or a line for the model.
    fn submit(&mut self, ctx: &egui::Context) {
        let text = self.input.trim().to_string();
        self.input.clear();
        if text.is_empty() {
            return;
        }
        let request = match slash::command(&text) {
            Some(Command::Help) => return self.transcript.notice(slash::HELP.to_string()),
            Some(Command::Exit) => return ctx.send_viewport_cmd(egui::ViewportCommand::Close),
            Some(command) => Request::Command(command),
            // Anything else, an unknown slash command included, goes to the model, as in the terminal.
            None => Request::Chat(text.clone()),
        };
        self.transcript.user_said(text);
        if self.worker.send(request) {
            self.busy = true;
        } else {
            self.end();
        }
    }

    fn status_text(&self) -> String {
        if self.ended {
            return "the session has ended".to_string();
        }
        if !self.busy {
            return "ready".to_string();
        }
        match self.transcript.progress {
            Progress::Prompt { processed, total } => format!("processing prompt: {processed} / {total} tokens"),
            Progress::Thinking(count) => format!("thinking: {count} tokens"),
            Progress::Idle => "working".to_string(),
        }
    }

    /// Draws one frame of the window.
    pub fn show(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();
        let status = self.status_text();
        egui::Panel::top("status").show(ui, |ui| {
            ui.label(RichText::new(status).color(DIM));
        });
        egui::Panel::bottom("input").show(ui, |ui| self.input_row(ui, &ctx));
        egui::CentralPanel::default().show(ui, |ui| self.transcript_view(ui));
        if let Some(change) = self.approval.clone() {
            self.approval_dialog(&ctx, &change);
        }
    }

    fn transcript_view(&self, ui: &mut egui::Ui) {
        egui::ScrollArea::vertical().auto_shrink([false, false]).stick_to_bottom(true).show(ui, |ui| {
            for item in &self.transcript.items {
                show_item(ui, item);
                ui.add_space(4.0);
            }
            if self.ended {
                ui.label(RichText::new("The session has ended. Close the window.").color(RED));
            }
        });
    }

    fn input_row(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let mut send = false;
        let enabled = !self.busy && !self.ended;
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            let edit = egui::TextEdit::multiline(&mut self.input)
                .desired_rows(3)
                .desired_width((ui.available_width() - 72.0).max(120.0))
                .hint_text("Message, or /help")
                // Enter sends; Shift+Enter starts a new line.
                .return_key(Some(KeyboardShortcut::new(Modifiers::SHIFT, Key::Enter)));
            let response = ui.add_enabled(enabled, edit);
            if enabled && self.focus_input {
                response.request_focus();
                self.focus_input = false;
            }
            if enabled && response.lost_focus() && ui.input(|input| input.key_pressed(Key::Enter)) {
                send = true;
            }
            ui.vertical(|ui| {
                if self.busy {
                    if ui.button("Stop").clicked() {
                        self.stop.request();
                    }
                } else if ui.add_enabled(enabled, egui::Button::new("Send")).clicked() {
                    send = true;
                }
            });
        });
        ui.add_space(4.0);
        if send {
            self.submit(ctx);
            self.focus_input = true;
        }
    }

    /// Asks whether to allow a change. Escape, a click outside, or No declines.
    fn approval_dialog(&mut self, ctx: &egui::Context, change: &str) {
        let mut answer = None;
        let modal = egui::Modal::new(egui::Id::unique("approval")).show(ctx, |ui| {
            ui.set_width(560.0);
            ui.heading("Allow this change?");
            ui.add_space(6.0);
            egui::ScrollArea::vertical().max_height(320.0).show(ui, |ui| {
                ui.label(RichText::new(change).monospace());
            });
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if ui.button("Yes").clicked() {
                    answer = Some(true);
                }
                if ui.button("No").clicked() {
                    answer = Some(false);
                }
            });
        });
        if modal.should_close() {
            answer = Some(false);
        }
        if let Some(accepted) = answer {
            self.worker.answer(accepted);
            self.approval = None;
        }
    }

    /// Ends the worker: a running turn is asked to stop, the shutdown commands run, and the thread is joined.
    fn shut_down(&mut self) {
        self.stop.request();
        self.worker.close();
        self.worker.join();
    }
}

fn show_item(ui: &mut egui::Ui, item: &Item) {
    match item {
        Item::User(text) => {
            egui::Frame::group(ui.style()).fill(ui.visuals().faint_bg_color).show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.label(RichText::new(text).strong());
            });
        }
        Item::Assistant { text, done } => {
            ui.label(text);
            if !done {
                ui.label(RichText::new("...").color(DIM));
            }
        }
        Item::Tool { name, target, failed, nested } => {
            ui.horizontal_wrapped(|ui| {
                if *nested {
                    ui.add_space(18.0);
                }
                ui.label(RichText::new("tool:").monospace().color(CYAN));
                let call = match target {
                    Some(target) => format!("{name} {target}"),
                    None => name.clone(),
                };
                ui.label(RichText::new(call).monospace().color(if failed.is_some() { RED } else { GREEN }));
                if let Some(reason) = failed {
                    ui.label(RichText::new(format!("did not run: {reason}")).monospace().color(RED));
                }
            });
        }
        Item::Notice(text) => {
            ui.label(RichText::new(text).monospace());
        }
        Item::Status(text) => {
            ui.label(RichText::new(text).color(DIM).italics());
        }
        Item::Error(text) => {
            ui.label(RichText::new(format!("error: {text}")).color(RED));
        }
    }
}

impl eframe::App for ViseApp {
    fn logic(&mut self, _ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.drain();
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.show(ui);
    }

    fn on_exit(&mut self) {
        self.shut_down();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vise_core::frontend::UiEvent;

    /// An app on a worker whose parts cannot be built, so no model is involved. Its first messages are an error and `Exited`.
    fn app() -> ViseApp {
        let stop = Stop::new();
        let worker = Worker::spawn(stop.clone(), false, || {}, || Err("no parts in this test".to_string()));
        ViseApp::new(worker, stop)
    }

    /// Runs `frames` frames of the window with no GPU.
    fn run(app: &mut ViseApp, frames: usize) {
        let ctx = egui::Context::default();
        for _ in 0..frames {
            let mut output = ctx.run_ui(egui::RawInput::default(), |ui| app.show(ui));
            // No renderer takes the texture changes here, and egui checks that they were handled.
            output.textures_delta.clear();
        }
    }

    #[test]
    fn every_state_of_the_window_draws() {
        let mut app = app();
        run(&mut app, 2);
        app.transcript.apply(UiEvent::Reply("hello".into()));
        app.transcript.user_said("hi".into());
        app.transcript.apply(UiEvent::Error("bad".into()));
        app.busy = true;
        app.transcript.progress = Progress::Prompt { processed: 1, total: 2 };
        run(&mut app, 2);
        app.approval = Some("create file x".into());
        run(&mut app, 2);
        app.approval = None;
        app.ended = true;
        run(&mut app, 2);
        app.shut_down();
    }

    #[test]
    fn draining_reports_a_worker_that_failed_to_start_and_marks_the_session_ended() {
        let mut app = app();
        for _ in 0..200 {
            app.drain();
            if app.ended {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(app.ended);
        assert!(app.transcript.items.contains(&Item::Error("no parts in this test".into())));
        app.shut_down();
    }

    #[test]
    fn help_is_answered_in_the_window_and_a_blank_line_sends_nothing() {
        let mut app = app();
        let ctx = egui::Context::default();
        app.input = "   ".into();
        app.submit(&ctx);
        assert!(app.transcript.items.is_empty());
        app.input = "/help".into();
        app.submit(&ctx);
        assert_eq!(app.transcript.items, vec![Item::Notice(slash::HELP.to_string())]);
        assert!(!app.busy);
        app.shut_down();
    }
}
