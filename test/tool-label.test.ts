import { expect, test } from "bun:test";
import { formatToolCall, toolLabel } from "../src/output/tool-line.ts";

test("a tool's name is shown as words", () => {
  expect(toolLabel("read_file")).toBe("Read file");
  expect(toolLabel("browser_wait_for_text")).toBe("Browser wait for text");
  expect(toolLabel("self")).toBe("Self");
});

test("a tool call line uses the friendly name", () => {
  expect(formatToolCall("read_file", { path: "src/a.ts" })).toBe("📄 Read file · src/a.ts");
  expect(formatToolCall("run_powershell", { command: "ls" })).toBe("💻 Run powershell · ls");
});
