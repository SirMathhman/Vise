use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use vise::{agent, chunk, commands, compaction, notes, saved_sessions, session, strata, tools, turn};

/// Set while a turn runs, so Ctrl+C stops the turn instead of quitting.
static TURN_ACTIVE: AtomicBool = AtomicBool::new(false);
/// Set by Ctrl+C during a turn; the turn checks it and stops.
static STOP: AtomicBool = AtomicBool::new(false);

use session::Session;
use turn::TurnError;
use chunk::Chunk;
use strata::Role;

#[derive(PartialEq, Clone, Copy)]
enum Section {
    Thinking,
    Answer,
}

/// Writes a streamed turn to the terminal. The reply and a subagent each keep their own section, so a subagent's
/// thinking and answer are labeled apart from the reply's, and every line of a subagent is indented under its header.
#[derive(Default)]
struct Printer {
    section: Option<Section>,
    subagent_section: Option<Section>,
    in_subagent: bool,
    /// True when the last text printed did not end a line.
    mid_line: bool,
}

impl Printer {
    fn chunk(&mut self, chunk: Chunk) {
        match chunk {
            Chunk::Reasoning(text) => self.text(text, Section::Thinking),
            Chunk::Content(text) => self.text(text, Section::Answer),
            Chunk::Tool(text) => {
                self.end_line();
                self.write(&format!("[tool] {text}\n"));
                *self.section() = None;
            }
            Chunk::SubagentStart { profile, task } => {
                self.end_line();
                self.write(&format!("[subagent {profile}] {task}\n"));
                self.section = None;
                self.subagent_section = None;
            }
            Chunk::Nested(step) => {
                self.in_subagent = true;
                self.chunk(*step);
                self.in_subagent = false;
            }
            Chunk::SubagentEnd { failed } => {
                self.end_line();
                if failed {
                    self.write("[subagent failed]\n");
                }
            }
            // The terminal does not run workflows, so no step starts here.
            Chunk::Step(_) => {}
            // The answer is read right after this line, so the cursor is left where the user types it.
            Chunk::Approval { name, arguments, result, .. } => {
                self.end_line();
                self.write(&format!(
                    "[approve] {name} {arguments}\n-> {result}\nKeep this edit? [y = keep, a = keep and allow this tool for the conversation, n = undo] "
                ));
                self.mid_line = false;
            }
        }
    }

    fn section(&mut self) -> &mut Option<Section> {
        if self.in_subagent { &mut self.subagent_section } else { &mut self.section }
    }

    fn text(&mut self, text: &str, next: Section) {
        if *self.section() != Some(next) {
            self.end_line();
            if next == Section::Thinking {
                self.write("[thinking] ");
            }
            *self.section() = Some(next);
        }
        self.write(text);
    }

    /// Prints text, indenting each line that starts inside a subagent.
    fn write(&mut self, text: &str) {
        for piece in text.split_inclusive('\n') {
            if self.in_subagent && !self.mid_line {
                print!("    ");
            }
            print!("{piece}");
            self.mid_line = !piece.ends_with('\n');
        }
        let _ = io::stdout().flush();
    }

    fn end_line(&mut self) {
        if self.mid_line {
            self.write("\n");
        }
    }
}

/// Starts a conversation with the built-in default profile: its tools are applied, and its instructions, if any,
/// join the conversation. The working directory's AGENTS.md is one of those instructions.
fn start_conversation(session: &mut Session, switches: &tools::Switches, working: Option<&Path>) {
    let choice = commands::default_profile(switches, working);
    if !choice.instructions.is_empty() {
        session.push(Role::Profile, choice.instructions);
    }
}

fn main() -> io::Result<()> {
    let config = vise::config::startup_config();
    let switches = tools::Switches::default();   // the REPL is one session: its own process and switches
    // Ctrl+C stops a running turn; at the prompt, or on a second Ctrl+C, it quits as before.
    if let Err(err) = ctrlc::set_handler(|| {
        if TURN_ACTIVE.load(Ordering::SeqCst) && !STOP.swap(true, Ordering::SeqCst) {
            return;
        }
        std::process::exit(0);
    }) {
        eprintln!("warning: Ctrl+C cannot stop a turn: {err}");
    }

    let mut session = Session::new();
    start_conversation(&mut session, &switches, config.working_dir.as_deref().map(Path::new));

    println!("Strata REPL ready. Type 'exit' or press Ctrl+C to quit. Type '/new' to start over.");

    loop {
        print!("> ");
        io::stdout().flush()?;

        let mut line = String::new();
        if io::stdin().read_line(&mut line)? == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed == "exit" || trimmed == "quit" {
            break;
        }
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "/new" {
            session.reset();
            start_conversation(&mut session, &switches, config.working_dir.as_deref().map(Path::new));
            println!("Started a new conversation.");
            continue;
        }
        if let Some(output) = saved_sessions::command(trimmed, &mut session, config.working_dir.as_deref().map(Path::new)) {
            println!("{output}");
            continue;
        }
        let home = std::env::home_dir();
        let roots = notes::Roots { working: config.working_dir.as_deref().map(Path::new), home: home.as_deref() };
        if let Some(output) = commands::handle(trimmed, &switches).or_else(|| notes::command(trimmed, roots)) {
            println!("{output}");
            continue;
        }

        let now = switches.snapshot();
        if let Some(result) = commands::profile(trimmed, &switches, roots) {
            match result {
                Ok(choice) => {
                    if !choice.instructions.is_empty() {
                        session.push(Role::Profile, choice.instructions);
                    }
                    println!("{}", choice.reply);
                }
                Err(err) => println!("error: {err}"),
            }
            continue;
        }

        let text = if strata::is_first_turn(session.messages()) {
            notes::with_index(trimmed, roots)
        } else {
            trimmed.to_owned()
        };
        session.push(Role::User, tools::note_changes(&text, session.told(), &now));
        let mut printer = Printer::default();
        STOP.store(false, Ordering::SeqCst);
        TURN_ACTIVE.store(true, Ordering::SeqCst);
        let result = agent::run_turn(session.messages(), &config, &switches, &STOP, &mut |chunk| printer.chunk(chunk));
        TURN_ACTIVE.store(false, Ordering::SeqCst);
        println!();
        match result {
            Err(err) => {
                session.pop();   // a turn that did not finish is not kept
                match &err {
                    TurnError::Stopped { .. } => println!("[stopped]"),
                    TurnError::Failed { .. } | TurnError::Step { .. } => eprintln!("{err}"),
                }
                let ran = err.ran();
                if !ran.is_empty() {
                    println!("{} tool call(s) ran before this, and their effects remain: {}", ran.len(), ran.join("; "));
                }
            }
            Ok(reply) => {
                session.push(Role::Assistant, reply);
                session.set_told(now);
                if let Some(entry) = compaction::after_turn(session.messages(), &config) {
                    if matches!(entry.role, Role::SummaryFailed) {
                        eprintln!("warning: could not summarize the conversation: {}", entry.content);
                    }
                    session.push(entry.role, entry.content);
                }
                if let Err(err) = saved_sessions::autosave(config.working_dir.as_deref().map(Path::new), &mut session) {
                    eprintln!("warning: could not autosave the conversation: {err}");
                }
            }
        }
    }

    println!("bye");
    Ok(())
}
