// A standalone TUI spike for evaluating an Ink-based REPL conversion. It
// deliberately imports NO Vise modules so it runs with no server: the "model"
// is a fake async generator that streams tokens with a small delay, exactly
// mimicking a real chat completion over the wire.
//
// It isolates the two parts that make a TUI conversion non-trivial:
//   1. Streaming model deltas into a live, growing assistant line.
//   2. An interactive prompt pinned below the conversation.
//
// Layout is a scrolling console (Ink's default, NOT alternate screen), which
// matches how the current Vise REPL already behaves. Ctrl-C exits.
import React, { useState } from "react";
import { Box, Static, Text, useApp, useInput, render } from "ink";

// Streams a reply token by token with a tiny pause between tokens, standing in
// for chatCompletionStream's onDelta callback.
async function* fakeModel(prompt: string): AsyncGenerator<string> {
  const reply =
    `You said "${prompt}". This reply arrives token by token, ` +
    "exactly the way a real streamed chat completion would be delivered: " +
    "the assistant line grows live, then commits to history and the prompt " +
    "returns, ready for the next turn.";
  for (const word of reply.split(" ")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    yield word + " ";
  }
}

type Done = { role: "user" | "assistant"; text: string };

export function App() {
  const { exit } = useApp();
  const [done, setDone] = useState<Done[]>([]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);

  const submit = async (raw: string) => {
    const prompt = raw.trim();
    if (prompt.length === 0 || busy) return;
    setBusy(true);
    setInput("");
    setCursor(0);
    setDone((d) => [...d, { role: "user", text: prompt }]);
    let acc = "";
    for await (const token of fakeModel(prompt)) {
      acc += token;
      setStreaming(acc);
    }
    setStreaming("");
    setDone((d) => [...d, { role: "assistant", text: acc }]);
    setBusy(false);
  };

  // useInput handles raw mode automatically. input is the typed character(s);
  // key is a bag of boolean modifiers / special-key flags.
  useInput((char, key) => {
    // Ctrl-C exits.
    if (key.ctrl && char === "\u0003") {
      exit();
      return;
    }
    // Enter submits the current input.
    if (key.return) {
      void submit(input);
      return;
    }
    // Backspace deletes the character before the cursor.
    if (key.backspace) {
      if (cursor === 0) return;
      const next = input.slice(0, cursor - 1) + input.slice(cursor);
      setInput(next);
      setCursor(cursor - 1);
      return;
    }
    // Arrow keys move the cursor within the current input.
    if (key.leftArrow && cursor > 0) {
      setCursor(cursor - 1);
      return;
    }
    if (key.rightArrow && cursor < input.length) {
      setCursor(cursor + 1);
      return;
    }
    // Normal printable input inserts at the cursor.
    if (char.length > 0 && !key.ctrl && !key.meta) {
      const next = input.slice(0, cursor) + char + input.slice(cursor);
      setInput(next);
      setCursor(cursor + char.length);
    }
  });

  // Split the input around the cursor so the caret renders in place.
  const before = input.slice(0, cursor);
  const after = input.slice(cursor);

  return (
    <Box flexDirection="column">
      {/* Committed history: rendered once via Static, never re-rendered. */}
      <Static items={done}>
        {(item, index) => (
          <Text key={index}>
            <Text color={item.role === "user" ? "cyan" : "green"}>
              {item.role === "user" ? "you> " : "assistant> "}
            </Text>
            {item.text}
          </Text>
        )}
      </Static>

      {/* Live streaming line: the hard part. Grows per token, then clears. */}
      {busy && streaming.length === 0 ? (
        <Text dimColor>
          <Text color="green">{"assistant> "}</Text>…
        </Text>
      ) : (
        <Text>
          <Text color="green">{"assistant> "}</Text>
          {streaming}
        </Text>
      )}

      {/* Interactive prompt, pinned below the conversation. */}
      <Box>
        <Text color="cyan">{"you> "}</Text>
        <Text>
          {before}
          <Text color={busy ? undefined : "white"}>|</Text>
          {after}
        </Text>
        {busy && (
          <Text dimColor>
            {"  (generating; Ctrl-C to exit)"}
          </Text>
        )}
      </Box>
    </Box>
  );
}

// Only start the live app when run directly (not when imported by the test).
if (import.meta.main) {
  render(<App />);
}
