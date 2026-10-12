import { expect, test } from "bun:test";
import { formatToolCall, toolLabel } from "../../packages/backend/src/output/tool-line.ts";
import { tools } from "../../packages/backend/src/tools.ts";
import { displayOfTool } from "../../packages/backend/src/tools/display.ts";

test("every tool declares how a call of it is shown, so a new tool cannot be forgotten", () => {
  const missing = tools.filter((t) => !t.display).map((t) => t.function.name);
  expect(missing).toEqual([]);
});

test("a tool call line uses the tool's own label and icon", () => {
  expect(formatToolCall("read_file", { path: "src/a.ts" }, displayOfTool)).toBe(
    "📄 Read file · src/a.ts",
  );
  expect(
    formatToolCall("run_powershell", { command: "ls" }, displayOfTool),
  ).toBe("💻 Run PowerShell · ls");
  expect(
    formatToolCall("browser_wait_for_idle", undefined, displayOfTool),
  ).toBe("⏳ Wait for page to settle");
});

test("a tool with no display of its own gets a name made from its identifier", () => {
  expect(toolLabel("read_file")).toBe("Read file");
  expect(formatToolCall("some_new_tool", { path: "x" }, displayOfTool)).toBe(
    "🔧 Some new tool · x",
  );
  expect(formatToolCall("read_file", { path: "x" })).toBe("🔧 Read file · x");
});
