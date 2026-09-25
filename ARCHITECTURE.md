# Vise — Architecture

## Definitions

- **REPL** — the interactive read-eval-print loop. The only user-facing entry point in the current form.
- **Evaluator** — the component that takes a source string and produces a result or a structured error.
- **Error type (`EvalError`)** — a structured, non-panicking error enum that carries enough context to answer: what went wrong, where, why, and how to fix it.
- **Command** — a user-typed line that is not ordinary evaluation (e.g. `/exit`, `/help`). Commands are intercepted by the REPL, not by the evaluator.

## Structure

```
vise/
├── src/
│   ├── main.rs        // Thin entry point: argument parsing, REPL loop
│   ├── repl.rs         // Prompt loop, line reading, command dispatch
│   ├── eval/
│   │   ├── mod.rs      // pub fn eval(input: &str) -> Result<Value, EvalError>
│   │   ├── parse.rs    // Source → AST
│   │   ├── ast.rs      // AST node definitions
│   │   ├── typecheck.rs// AST → typed AST (when types are introduced)
│   │   └── interpret.rs// AST → Value (tree-walking or bytecode)
│   ├── value.rs        // Runtime value type (Number, String, List, Closure, …)
│   └── error.rs         // EvalError enum
```

**Dependency direction:** `main → repl → eval → parse/ast/value/error`. No upward or circular dependencies. `main` owns I/O; `repl` owns loop control; `eval` is pure and side-effect-free so it is trivially testable.

### Crate layout (when the codebase outgrows a single binary crate)

Once the evaluator exceeds ~1 000 lines, split into a workspace:

```
vise/
├── Cargo.toml          // workspace
├── vise-core/           // eval, parse, ast, value, error — no I/O
├── vise-repl/           // depends on vise-core; owns the prompt loop
└── vise-bin/            // depends on both; `fn main` is ~10 lines
```

This lets `vise-core` be reused as a library (embedding, scripting, future LSP) without pulling in terminal I/O.

## Potential Problems

- **`eval` returning `String` instead of `Result<Value, EvalError>`** — will force error-as-string or panics into every call site. Must be resolved before real logic is added.
- **GIL / borrow conflicts in a future multi-line REPL** — if the evaluator needs to retain state between lines (variables, closures), the stateful `Evaluator` struct must own its heap; the REPL must own the evaluator and pass `&mut` in.
- **Line-buffering vs. raw mode** — `read_line` is fine for one-line commands. Multi-line input (e.g. block expressions) will require either a continuation prompt or a raw-mode line editor (e.g. `rustyline`).
- **UTF-8 / terminal width** — `print!` assumes the terminal can render the prompt; wide or emoji input will need `unicode-width` or a TUI crate if the REPL grows a status bar.

## Future Work

- Introduce `Value` type and `EvalError` enum; convert `eval` to return `Result<Value, EvalError>`.
- Extract `repl.rs` from `main.rs` once the loop exceeds ~50 lines or a second input source is added (file mode, script argument).
- Add `parse.rs` / `ast.rs` when the first real expression grammar is defined.
- Move `eval` into `vise-core` crate when the binary and a potential library API diverge.
- Add unit tests in `vise-core` for parse, typecheck, and interpret — these are the highest-value tests because they need no terminal.
- Consider a `rustyline` or `reedline` dependency for a real line editor once multi-line input is needed.

## Performance

- **Parser throughput** — for a tree-walking interpreter, parsing will be the bottleneck at scale; a recursive-descent parser is fine up to several hundred lines before a Pratt parser or parser combinator library becomes worthwhile. Profile before optimising.
- **I/O latency** — the REPL loop is I/O-bound; `BufReader` over `stdin` and `BufWriter` over `stdout` will reduce syscalls but are unlikely to be the bottleneck in an interactive REPL.
