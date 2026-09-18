/**
 * Best-effort extraction of a string field's value out of a JSON object's
 * text while that text is still being streamed in and may be incomplete or
 * temporarily invalid JSON. Used to show a model-generated tool call's
 * arguments (e.g. edit_file's `content`) live, token by token, before the
 * call has finished arriving.
 *
 * Only string-valued fields are supported (the values this app needs to
 * stream live — `path`, `content` — are always strings). The scan is
 * one-directional and stateless: given the full accumulated text so far, it
 * re-finds the field and re-decodes it each call. That is O(n) per call
 * rather than incremental, but tool-call argument strings are small (well
 * under a file's size cap) and streamed at token, not byte, rate, so this is
 * cheap in practice and far simpler than maintaining scan-position state.
 */

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decode a JSON string body (the raw text *after* the opening quote, not yet
 * validated) up to its closing unescaped quote or the end of the available
 * text, whichever comes first. A trailing incomplete escape sequence (a
 * lone `\`, or a `\u` short of its 4 hex digits) is held back rather than
 * guessed at, so a value is never returned with a mangled last character
 * while more of the escape is still streaming in.
 */
function decodeJsonStringBody(raw: string): string {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      return out; // unescaped closing quote: the value ends here
    }
    if (ch === "\\") {
      if (i + 1 >= raw.length) break; // incomplete trailing escape
      const next = raw[i + 1];
      if (next === "u") {
        if (i + 6 > raw.length) break; // incomplete \uXXXX
        const code = Number.parseInt(raw.slice(i + 2, i + 6), 16);
        out += Number.isNaN(code) ? "" : String.fromCharCode(code);
        i += 6;
        continue;
      }
      const simple: Record<string, string> = {
        n: "\n",
        t: "\t",
        r: "\r",
        '"': '"',
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
      };
      out += simple[next] ?? next;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Find `"key": "` (with optional whitespace around the colon) in a partial
 * JSON object's text and decode everything after it as a JSON string body,
 * per {@link decodeJsonStringBody}. Returns "" if the key's opening quote
 * hasn't appeared yet (or the key is absent).
 */
export function extractPartialJsonString(
  partialJson: string,
  key: string
): string {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"`);
  const m = re.exec(partialJson);
  if (!m) return "";
  return decodeJsonStringBody(partialJson.slice(m.index + m[0].length));
}

/**
 * Find `"key": <integer>` in a partial JSON object's text. Unlike a string
 * field, a number has no closing delimiter of its own, so a digit sequence
 * that hasn't finished streaming (e.g. "1" of an eventual "12") would
 * otherwise read as a smaller, wrong number. This only returns a value once
 * a `,` or `}` has appeared right after the digits, proving the model has
 * moved on to the next field (or closed the object) and the number can't
 * still be growing — so it's safe to call on every chunk regardless of
 * where this key falls in the object's (model-chosen, not guaranteed)
 * field order, unlike a scheme that assumes a later field's appearance
 * implies this one is done.
 */
export function extractPartialJsonNumber(
  partialJson: string,
  key: string
): number | undefined {
  const re = new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*(-?\\d+)\\s*[,}]`);
  const m = re.exec(partialJson);
  return m ? Number(m[1]) : undefined;
}
