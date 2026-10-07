import type { Tool } from "../core/engine.ts";
import type { AssistantMessage, Message, ToolCall } from "../core/errors.ts";

/**
 * Prompt-text tool-call protocol. Tool definitions are rendered into the
 * system prompt as stable text and calls are emitted as delimited JSON in the
 * assistant content. Which tools may be *called* is enforced per request by a
 * GBNF grammar, which is not part of the prompt — so enabling or disabling a
 * tool never changes the prompt prefix and never invalidates the KV cache.
 */
export const CALL_OPEN = "<tool_call>";
export const CALL_CLOSE = "</tool_call>";
/** Emitted in act mode when the plan is complete (see `buildGrammar`). */
export const DONE = "<done/>";
const RESPONSE_OPEN = "<tool_response>\n";
const RESPONSE_CLOSE = "\n</tool_response>";

/** The system-prompt section describing every tool and the call format. */
export function renderToolPrompt(tools: Tool[]): string {
  const defs = tools.map((t) => JSON.stringify(t.function)).join("\n");
  return [
    "# Tools",
    "",
    "You may call one or more functions to assist with the user query, only when they are actually needed; answer directly otherwise.",
    "",
    "You are provided with function signatures within <tools></tools> XML tags:",
    "<tools>",
    defs,
    "</tools>",
    "",
    `For each function call, return a json object with function name and arguments within ${CALL_OPEN}${CALL_CLOSE} XML tags:`,
    `${CALL_OPEN}\n{"name": <function-name>, "arguments": <args-json-object>}\n${CALL_CLOSE}`,
    "Function results are returned in <tool_response></tool_response> tags.",
    "Tools may be enabled or disabled during the conversation; follow the most recent notice about a tool's state and never call a disabled tool.",
  ].join("\n");
}

const JSON_VALUE_RULES = String.raw`
ws ::= [ \t\n]*
value ::= object | array | string | number | ("true" | "false" | "null")
object ::= "{" ws ( string ws ":" ws value ( ws "," ws string ws ":" ws value )* )? ws "}"
array ::= "[" ws ( value ( ws "," ws value )* )? ws "]"
string ::= "\"" ( [^"\\\x7F\x00-\x1F] | "\\" ( ["\\/bfnrt] | "u" [0-9a-fA-F]{4} ) )* "\""
number ::= "-"? ( [0-9] | [1-9] [0-9]* ) ( "." [0-9]+ )? ( [eE] [-+]? [0-9]+ )?`;

/**
 * Rules for `text`: any characters (reasoning, `</think>`, plain reply) that
 * never contain `CALL_OPEN`. One rule per prefix length of the delimiter; a
 * mismatch falls back to the start (or to state 1 on `<`), which is exact
 * because the delimiter's only `<` is its first character.
 */
function textRules(): string[] {
  const p = CALL_OPEN;
  const rules: string[] = [];
  for (let k = 0; k < p.length; k++) {
    const next = k === 0 ? "" : (p[k] ?? "");
    const alts = [`[^<${next}] t0`, `"<" t1`];
    if (k > 0 && k < p.length - 1) alts.push(`"${next}" t${k + 1}`);
    rules.push(`t${k} ::= ( ${alts.join(" | ")} )?`);
  }
  return rules;
}

/**
 * GBNF grammar: `text` (which cannot contain `CALL_OPEN`) followed by any
 * number of calls whose `name` is restricted to `enabled`. The model can
 * therefore think, answer in plain text, or call an enabled tool — and never
 * call a disabled one. llama.cpp ignores lazy-grammar triggers on this
 * endpoint, so the grammar itself carries the optionality. Returns undefined
 * when no tool is enabled; the runner then rejects any call text that slips
 * through.
 */
export function buildGrammar(
  enabled: string[],
  act = false,
): string | undefined {
  if (act && enabled.length === 0) return `root ::= "${DONE}"`;
  if (enabled.length === 0) return undefined;
  const lit = (s: string): string =>
    `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const nameRule = enabled.map((n) => lit(`"${n}"`));
  return [
    act ? `root ::= call+ | "${DONE}"` : "root ::= t0 call*",
    ...(act ? [] : textRules()),
    `call ::= "${CALL_OPEN}" ws "{" ws "\\"name\\"" ws ":" ws name ws "," ws "\\"arguments\\"" ws ":" ws object ws "}" ws "${CALL_CLOSE}" ws`,
    `name ::= ${nameRule.join(" | ")}`,
    JSON_VALUE_RULES,
  ].join("\n");
}

/**
 * Request fields that restrict calls to the enabled `tools`. In `act` mode the
 * model may only call a tool or emit `DONE` — it cannot think or answer — and
 * token probabilities are requested so the engine can escalate an uncertain
 * choice back to thinking.
 */
export function toolRequestFields(
  tools: Tool[],
  isToolEnabled?: (name: string) => boolean,
  act = false,
): Record<string, unknown> {
  const enabled = tools
    .map((t) => t.function.name)
    .filter((n) => isToolEnabled?.(n) ?? true);
  const grammar = buildGrammar(enabled, act);
  if (grammar === undefined) return {};
  return act ? { grammar, logprobs: true, top_logprobs: 1 } : { grammar };
}

/**
 * Extract tool calls from a reply. A model that skips its reasoning block and
 * opens with a call has it reported as reasoning text by the server, so fall
 * back to the reasoning text when the content holds no call.
 */
export function parseReply(
  message: AssistantMessage,
  thinkingText: string,
  act = false,
): AssistantMessage {
  if (act && (message.content.includes(DONE) || thinkingText.includes(DONE))) {
    return { ...message, content: "", done: true };
  }
  // Outside act mode the marker is just stray text (the model was told about
  // it); drop it so it never reaches the user.
  message = {
    ...message,
    content: message.content.replaceAll(DONE, "").trim(),
  };
  let parsed = parseToolCalls(message.content);
  if (parsed.tool_calls.length === 0 && message.content.trim() === "") {
    const at = thinkingText.indexOf(CALL_OPEN);
    if (at >= 0) parsed = parseToolCalls(thinkingText.slice(at));
  }
  return {
    ...message,
    content: parsed.content,
    ...(thinkingText ? { reasoning: thinkingText } : {}),
    ...(parsed.tool_calls.length > 0 ? { tool_calls: parsed.tool_calls } : {}),
  };
}

/** Convert conversation history into the plain-text protocol for the server. */
export function encodeMessages(
  messages: Message[],
  tools: Tool[],
): Record<string, string>[] {
  const out: Record<string, string>[] = messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: `${RESPONSE_OPEN}${m.content}${RESPONSE_CLOSE}`,
      };
    }
    const calls = (m.tool_calls ?? [])
      .map(
        (c) =>
          `${CALL_OPEN}
${JSON.stringify({ name: c.function.name, arguments: safeParse(c.function.arguments) })}
${CALL_CLOSE}`,
      )
      .join("");
    return { role: m.role, content: m.content + calls };
  });
  const prompt = renderToolPrompt(tools);
  const first = out[0];
  if (first && first.role === "system") {
    first.content = `${first.content}\n\n${prompt}`;
  } else {
    out.unshift({ role: "system", content: prompt });
  }
  return out;
}

function safeParse(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

/** Split assistant text into prose and parsed tool calls. */
export function parseToolCalls(content: string): {
  content: string;
  tool_calls: ToolCall[];
} {
  const start = content.indexOf(CALL_OPEN);
  if (start < 0) return { content, tool_calls: [] };
  const calls: ToolCall[] = [];
  const stamp = Date.now();
  let from = start;
  while (from >= 0) {
    const bodyStart = from + CALL_OPEN.length;
    const end = content.indexOf(CALL_CLOSE, bodyStart);
    if (end < 0) break;
    try {
      const parsed = JSON.parse(content.slice(bodyStart, end)) as {
        name: string;
        arguments?: unknown;
      };
      calls.push({
        type: "function",
        id: `call_${stamp}_${calls.length}`,
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.arguments ?? {}),
        },
      });
    } catch {
      // Malformed call text is dropped; the grammar normally prevents this.
    }
    from = content.indexOf(CALL_OPEN, end + CALL_CLOSE.length);
  }
  return { content: content.slice(0, start).trimEnd(), tool_calls: calls };
}

/**
 * Wrap a token callback so streamed output stops at the first call delimiter
 * (call text is parsed from the final message, not shown to the user) and the
 * `DONE` marker is dropped wherever it appears.
 */
export function hideCalls(
  onToken?: (token: string) => void,
): ((token: string) => void) | undefined {
  if (!onToken) return undefined;
  let held = "";
  let hidden = false;
  const show = (text: string): void => {
    const clean = text.replaceAll(DONE, "");
    if (clean) onToken(clean);
  };
  return (token) => {
    if (hidden) return;
    held += token;
    const at = held.indexOf(CALL_OPEN);
    if (at >= 0) {
      hidden = true;
      show(held.slice(0, at));
      return;
    }
    // Keep back any tail that could still become a delimiter or marker.
    let keep = 0;
    for (let n = Math.min(CALL_OPEN.length - 1, held.length); n > 0; n--) {
      const tail = held.slice(held.length - n);
      if (CALL_OPEN.startsWith(tail) || DONE.startsWith(tail)) {
        keep = n;
        break;
      }
    }
    const emit = held.slice(0, held.length - keep);
    held = held.slice(held.length - keep);
    show(emit);
  };
}

/** A generated token with its log probability (llama.cpp `logprobs`). */
export interface TokenLogprob {
  token: string;
  logprob: number;
}

/**
 * Lowest token probability inside any `"name":"<tool>"` value of the output:
 * how sure the model was when it chose each tool. Tokens that the grammar
 * forced report probability 1, so only genuine choices pull this down.
 */
export function nameConfidence(tokens: TokenLogprob[]): number | undefined {
  const text = tokens.map((t) => t.token).join("");
  const spans = [...text.matchAll(/"name"\s*:\s*"([^"]*)"/g)].map((m) => {
    const end = m.index + m[0].length - 1;
    return [end - (m[1]?.length ?? 0), end] as const;
  });
  let min: number | undefined;
  let at = 0;
  for (const t of tokens) {
    const start = at;
    at += t.token.length;
    if (spans.some(([s, e]) => start < e && at > s)) {
      const p = Math.exp(t.logprob);
      min = min === undefined ? p : Math.min(min, p);
    }
  }
  return min;
}
