// Headless smoke test for the TUI spike. It imports the same App component and
// renders it to a string with Ink's renderToString (no TTY / raw mode needed),
// proving the React + Ink render path is sound without a terminal. Note:
// renderToString is a single synchronous render, so it reflects the initial
// frame only; streaming is exercised separately via the live spike.
//
// Run: bun spike/tui-spike-test.ts
import React from "react";
import { renderToString } from "ink";
import { App } from "./tui-spike";

const frame = renderToString(React.createElement(App));
console.log("=== initial frame ===");
console.log(frame);

if (!frame.includes("you>")) {
  throw new Error("expected the 'you>' prompt in the initial frame");
}
console.log("\nOK: spike rendered headlessly without throwing.");
