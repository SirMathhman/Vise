import { describe, expect, test } from "bun:test";
import { CallLog, CallTrace } from "../../packages/backend/src/client/stream/call-trace.ts";
import { LlmClient, streamChat } from "../../packages/backend/src/client/llm.ts";
import { applySettings } from "../../packages/backend/src/config.ts";
import type { AuditEvent, AuditSink } from "@vise/core";

describe("CallTrace", () => {
  test("keeps the start and a rolling end of a very long text", () => {
    const trace = new CallTrace(1, "reply", "m");
    trace.text("START");
    for (let i = 0; i < 40; i++) trace.text("x".repeat(10_000));
    trace.text("END");
    const raw = trace.raw();
    expect(trace.chars).toBe(400_008);
    expect(raw.startsWith("START")).toBe(true);
    expect(raw.endsWith("END")).toBe(true);
    expect(raw).toContain("characters left out");
    expect(raw.length).toBeLessThan(300_000);
    expect(trace.rawTail(3)).toBe("END");
  });

  test("ends once, with the first reason", () => {
    const trace = new CallTrace(1, "reply", "m");
    trace.end("stopped", "loop");
    trace.end("done");
    expect(trace.state).toBe("stopped");
    expect(trace.stopReason).toBe("loop");
  });

  test("the log lists running calls before finished ones, newest first", () => {
    const log = new CallLog();
    const a = log.start(new CallTrace(1, "reply", "m"));
    const b = log.start(new CallTrace(2, "goal", "m"));
    log.finish(a);
    expect(log.traces().map((t) => t.request)).toEqual([2, 1]);
    expect(log.current()).toBe(b);
    expect(log.get(1)).toBe(a);
  });
});

describe("streamChat reports why the server ended the call", () => {
  test("finish_reason reaches the listener", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n';
    const stream = new Response(body).body as ReadableStream<Uint8Array>;
    const reasons: string[] = [];
    await streamChat(stream, undefined, undefined, undefined, undefined, {
      text: () => undefined,
      tokens: () => undefined,
      finish: (reason) => reasons.push(reason),
    });
    expect(reasons).toEqual(["length"]);
  });
});

describe("the runaway guard", () => {
  const sse = (chunks: string[]): string =>
    chunks
      .map(
        (text, i) =>
          `data: ${JSON.stringify({
            choices: [{ delta: { content: text } }],
            timings: { predicted_n: (i + 1) * 60 },
          })}\n\n`,
      )
      .join("");

  async function run(chunks: string[], capture?: AuditEvent[]) {
    const client = new LlmClient();
    const sink: AuditSink = { record: (e) => void capture?.push(e) };
    client.setAuditSink(sink);
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(sse(chunks) + "data: [DONE]\n\n", { status: 200 })) as unknown as typeof fetch;
    try {
      return { client, result: await client.chat([{ role: "user", content: "x" }]) };
    } finally {
      globalThis.fetch = real;
    }
  }

  test("a call that repeats itself is stopped and reported as a runaway", async () => {
    const piece = "The same sentence over and over again, ok? ";
    const events: AuditEvent[] = [];
    const { client, result } = await run(
      Array.from({ length: 80 }, () => piece),
      events,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: "runaway", reason: "loop", purpose: "reply" });
    const call = events.find((e) => e.kind === "model_call");
    expect(call).toMatchObject({ stopReason: "loop", request: 1 });
    const trace = client.calls.get(1);
    expect(trace?.state).toBe("stopped");
    expect(trace?.loop()?.period).toBe(piece.length);
  });

  test("a provider that sends no token count still gets its looping call stopped", async () => {
    // Some providers stream content deltas with no `timings`; the guard must still judge them.
    const piece = "<invoke_tool>\n</invoke_tool>\n\n";
    const body =
      Array.from(
        { length: 200 },
        () => `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
      ).join("") + "data: [DONE]\n\n";
    const client = new LlmClient();
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await client.chat([{ role: "user", content: "x" }]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ kind: "runaway", reason: "loop" });
    } finally {
      globalThis.fetch = real;
    }
  });

  test("a call over the token cap is stopped", async () => {
    applySettings({ VISE_MAX_CALL_TOKENS: "100" });
    try {
      const chunks = Array.from(
        { length: 20 },
        (_, i) => `different text number ${i} with its own words. `,
      );
      const { result } = await run(chunks);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ kind: "runaway", reason: "token_cap" });
    } finally {
      applySettings({});
    }
  });

  test("a normal call is not touched, and is recorded raw", async () => {
    const events: AuditEvent[] = [];
    const { result } = await run(["Hello ", "there."], events);
    expect(result.ok).toBe(true);
    expect(events.find((e) => e.kind === "model_call")).toMatchObject({
      raw: "Hello there.",
      completionTokens: 120,
    });
  });
});

describe("a looping call is asked again", () => {
  const stream = (texts: string[]): string =>
    texts
      .map(
        (text, i) =>
          `data: ${JSON.stringify({
            choices: [{ delta: { content: text } }],
            timings: { predicted_n: (i + 1) * 60 },
          })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n";
  const looping = stream(
    Array.from({ length: 60 }, () => "The same sentence over and over again, ok? "),
  );
  const fine = stream(["All ", "good."]);

  async function run(responses: string[], events: AuditEvent[] = []) {
    const client = new LlmClient();
    client.setAuditSink({ record: (e) => void events.push(e) });
    const bodies: Record<string, unknown>[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      bodies.push(JSON.parse(init?.body ?? "{}"));
      return new Response(responses[bodies.length - 1] ?? responses[responses.length - 1], {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const tokens: string[] = [];
    try {
      const result = await client.chat([{ role: "user", content: "x" }], undefined, (t) =>
        tokens.push(t),
      );
      return { client, result, bodies, tokens };
    } finally {
      globalThis.fetch = real;
    }
  }

  test("one retry with a repeat penalty, and both calls on the record", async () => {
    const events: AuditEvent[] = [];
    const { client, result, bodies, tokens } = await run([looping, fine], events);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("All good.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).not.toHaveProperty("dry_multiplier");
    expect(bodies[1]).toMatchObject({ dry_multiplier: 0.8, repeat_penalty: 1.1 });
    expect(client.calls.get(1)?.stopReason).toBe("loop");
    expect(client.calls.get(2)?.state).toBe("done");
    expect(tokens.join("")).toContain("asking again");
    expect(events.filter((e) => e.kind === "model_call")).toHaveLength(2);
  });

  test("a second loop fails the turn: only one retry", async () => {
    const { result, bodies } = await run([looping, looping, fine]);
    expect(bodies).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatchObject({ kind: "runaway", reason: "loop" });
  });

  test("VISE_LOOP_RETRIES=0 turns it off", async () => {
    applySettings({ VISE_LOOP_RETRIES: "0" });
    try {
      const { result, bodies } = await run([looping, fine]);
      expect(bodies).toHaveLength(1);
      expect(result.ok).toBe(false);
    } finally {
      applySettings({});
    }
  });

  test("a token cap is not retried", async () => {
    applySettings({ VISE_MAX_CALL_TOKENS: "100" });
    try {
      const long = stream(
        Array.from({ length: 20 }, (_, i) => `different text number ${i} with its own words. `),
      );
      const { result, bodies } = await run([long, fine]);
      expect(bodies).toHaveLength(1);
      expect(result.ok).toBe(false);
    } finally {
      applySettings({});
    }
  });
});
