import type { TranscriptView } from "./transcript.ts";

/** Development measurement of a long chat (`?bench=<lines>`): what a line costs, what streaming a long reply costs, what scrolling costs. */
interface Bench {
  lines: number;
  appendMeanMs: number;
  appendP95Ms: number;
  streamFrames: number;
  streamFrameP95Ms: number;
  streamTotalMs: number;
  scrollFiftyJumpsMs: number;
  domNodes: number;
  heapMB?: number;
}

/** The next animation frame, or after 100 ms if the page is not being painted (a hidden tab). */
const frame = (): Promise<number> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(performance.now()), 100);
    requestAnimationFrame((now) => {
      clearTimeout(timer);
      resolve(now);
    });
  });

const percentile = (values: number[], p: number): number =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length * p)] ?? 0;

const REPLY = `Here is a paragraph with **bold**, \`code\` and a [link](https://example.com).

- one item
- another item

\`\`\`ts
const answer = 42;
console.log(answer);
\`\`\`

`;

export async function runBench(
  transcript: TranscriptView,
  lines: number,
): Promise<Bench> {
  const log = document.getElementById("log") as HTMLElement;
  // Let the page finish connecting: restoring the last session replaces the log.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const costs: number[] = [];
  for (let i = 0; i < lines; i++) {
    const started = performance.now();
    switch (i % 4) {
      case 0:
        transcript.addLine("user", `message ${i}: how does this work?`);
        break;
      case 1:
        transcript.appendAssistantToken(`${REPLY}reply ${i}`);
        transcript.flushAssistant();
        break;
      case 2:
        transcript.appendToolCall("read_file", 0, `📄 read_file · src/file${i}.ts`);
        break;
      default:
        transcript.appendThinkingToken(`thinking about step ${i} `.repeat(8));
        transcript.finishThinking();
    }
    costs.push(performance.now() - started);
    if (i % 500 === 499) await frame();
  }
  await frame();

  // One long reply, streamed ten tokens per frame.
  const streamStart = performance.now();
  const frames: number[] = [];
  let last = await frame();
  for (let k = 0; k < 400; k++) {
    for (let t = 0; t < 10; t++) transcript.appendAssistantToken(`${REPLY}word${k}-${t} `);
    const now = await frame();
    frames.push(now - last);
    last = now;
  }
  transcript.flushAssistant();
  const streamTotalMs = performance.now() - streamStart;

  const scrollStart = performance.now();
  for (let k = 0; k < 50; k++) {
    log.scrollTop = k % 2 === 0 ? 0 : log.scrollHeight;
    void log.scrollHeight; // forces the layout the jump needs
  }
  const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const result: Bench = {
    lines,
    appendMeanMs: costs.reduce((a, b) => a + b, 0) / Math.max(costs.length, 1),
    appendP95Ms: percentile(costs, 0.95),
    streamFrames: frames.length,
    streamFrameP95Ms: percentile(frames, 0.95),
    streamTotalMs,
    scrollFiftyJumpsMs: performance.now() - scrollStart,
    domNodes: log.querySelectorAll("*").length,
    ...(heap ? { heapMB: Math.round(heap.usedJSHeapSize / 1e6) } : {}),
  };
  (window as unknown as { __viseBench: Bench }).__viseBench = result;
  transcript.addLine("system", `bench: ${JSON.stringify(result)}`);
  return result;
}
