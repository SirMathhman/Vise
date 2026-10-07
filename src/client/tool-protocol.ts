import type { Tool } from "../core/engine.ts";
import type { AssistantMessage, Message, ToolCall } from "../core/errors.ts";

/**
 * Prompt-text tool-call protocol. Tool definitions are rendered into the
 * system prompt as stable text and calls are emitted as delimited JSON in the
 * assistant content. Which tools may be *called* is enforced per request by a
 * GBNF grammar, which is not part of the prompt — so enabling or disabling a
 * tool never changes the prompt prefix and never invalidates the KV cache.
 */
export const CALL_OPEN = "<|tool_call|>";
export const CALL_CLOSE = "<|/tool_call|>";
const RESPONSE_OPEN = "<|tool_response|>";
const RESPONSE_CLOSE = "<|/tool_response|>";

/** The system-prompt section describing every tool and the call format. */
export function renderToolPrompt(tools: Tool[]): string {
  const defs = tools.map((t) => JSON.stringify(t.function)).join("\n");
  return [
    "You can call tools. Available tools (one JSON definition per line):",
    defs,
    "",
    `To call a tool, end your reply with ${CALL_OPEN}{"name":"<tool>","arguments":{...}}${CALL_CLOSE}.`,
    "You may emit several calls in a row. Results are returned in messages",
    `wrapped in ${RESPONSE_OPEN}...${RESPONSE_CLOSE}. A reply without a call is final.`,
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
 * Lazy GBNF grammar, mirroring how llama.cpp constrains native tool calls:
 * output is unconstrained until `CALL_OPEN` appears (see `GRAMMAR_TRIGGERS`),
 * and from there on must be calls whose `name` is restricted to `enabled`.
 * Returns undefined when no tool is enabled; the runner then rejects any
 * call text that slips through.
 */
export function buildGrammar(enabled: string[]): string | undefined {
  if (enabled.length === 0) return undefined;
  const lit = (s: string): string =>
    `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const nameRule = enabled.map((n) => lit(`"${n}"`));
  return [
    "root ::= call+",
    `call ::= "${CALL_OPEN}" ws "{" ws "\\"name\\"" ws ":" ws name ws "," ws "\\"arguments\\"" ws ":" ws object ws "}" ws "${CALL_CLOSE}" ws`,
    `name ::= ${nameRule.join(" | ")}`,
    JSON_VALUE_RULES,
  ].join("\n");
}

// llama.cpp trigger types: 0 = word, 3 = full-buffer pattern.
const WORD_TRIGGER = [{ type: 0, value: CALL_OPEN }];
// With thinking on, the output starts inside the reasoning block; only start
// constraining once it has closed, or a mention of the delimiter while
// thinking would trap the model in the grammar.
const AFTER_THINKING_TRIGGER = [
  {
    type: 3,
    value: String.raw`[\s\S]*</think>[\s\S]*?(<\|tool_call\|>[\s\S]*)`,
  },
];

/** Request fields that restrict calls to `enabled` tools (none if empty). */
export function toolRequestFields(
  enabled: string[],
  thinking: boolean,
): Record<string, unknown> {
  const grammar = buildGrammar(enabled);
  if (grammar === undefined) return {};
  return {
    grammar,
    grammar_lazy: true,
    grammar_triggers: thinking ? AFTER_THINKING_TRIGGER : WORD_TRIGGER,
  };
}

/**
 * Extract tool calls from a reply. A model that skips its reasoning block and
 * opens with a call has it reported as reasoning text by the server, so fall
 * back to the reasoning text when the content holds no call.
 */
export function parseReply(
  message: AssistantMessage,
  thinkingText: string,
): AssistantMessage {
  let parsed = parseToolCalls(message.content);
  if (parsed.tool_calls.length === 0 && message.content.trim() === "") {
    const at = thinkingText.indexOf(CALL_OPEN);
    if (at >= 0) parsed = parseToolCalls(thinkingText.slice(at));
  }
  return {
    ...message,
    content: parsed.content,
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
          `${CALL_OPEN}${JSON.stringify({ name: c.function.name, arguments: safeParse(c.function.arguments) })}${CALL_CLOSE}`,
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
 * (call text is parsed from the final message, not shown to the user).
 */
export function hideCalls(
  onToken?: (token: string) => void,
): ((token: string) => void) | undefined {
  if (!onToken) return undefined;
  let held = "";
  let hidden = false;
  return (token) => {
    if (hidden) return;
    held += token;
    const at = held.indexOf(CALL_OPEN);
    if (at >= 0) {
      hidden = true;
      if (at > 0) onToken(held.slice(0, at));
      return;
    }
    // Keep back any tail that could still become the delimiter.
    let keep = 0;
    for (let n = Math.min(CALL_OPEN.length - 1, held.length); n > 0; n--) {
      if (CALL_OPEN.startsWith(held.slice(held.length - n))) {
        keep = n;
        break;
      }
    }
    const emit = held.slice(0, held.length - keep);
    held = held.slice(held.length - keep);
    if (emit) onToken(emit);
  };
}
