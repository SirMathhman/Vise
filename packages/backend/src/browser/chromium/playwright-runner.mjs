// Runs Playwright snippets for Vise in a separate Node process. Playwright's
// CDP transport does not work under Bun, and a snippet is arbitrary code, so
// it is kept out of the Vise server process. Protocol: one JSON object per
// line on stdin ({ id, wsUrl, targetId, code }); one per line on stdout
// ({ id, ok: true, result } or { id, ok: false, error }).
import process from "node:process";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
const MAX_RESULT_CHARS = 10000;

let browserPromise = null;
let connectedTo = "";

function connect(wsUrl) {
  if (!browserPromise || connectedTo !== wsUrl) {
    connectedTo = wsUrl;
    browserPromise = chromium.connectOverCDP(wsUrl).then((browser) => {
      // A dialog listener stops Playwright auto-dismissing dialogs, so
      // browser_handle_dialog stays in charge of them.
      const hold = (page) => page.on("dialog", () => {});
      for (const context of browser.contexts()) {
        context.pages().forEach(hold);
        context.on("page", hold);
      }
      return browser;
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

async function pageFor(browser, targetId) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const session = await context.newCDPSession(page);
      try {
        const { targetInfo } = await session.send("Target.getTargetInfo");
        if (targetInfo.targetId === targetId) return page;
      } finally {
        await session.detach().catch(() => undefined);
      }
    }
  }
  throw new Error("Playwright could not find that tab");
}

async function run({ wsUrl, targetId, code }) {
  const page = await pageFor(await connect(wsUrl), targetId);
  const result = await new AsyncFunction("page", code)(page);
  const text = result === undefined ? "done" : JSON.stringify(result);
  return text.length > MAX_RESULT_CHARS
    ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${text.length} characters total]`
    : text;
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const result = await run(request);
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: message })}\n`);
  }
});
// The parent closing our stdin ends the session: disconnect so the process drains and exits.
process.stdin.on("end", () => {
  void browserPromise?.then((browser) => browser.close()).catch(() => undefined);
});
