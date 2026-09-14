// Very basic, dependency-free syntax highlighting.
// Tokenizes a single line into runs of text tagged with a CSS class.
// It is intentionally crude: no cross-line state, no language detection.

export type TokenClass =
  | "tok-comment"
  | "tok-string"
  | "tok-number"
  | "tok-keyword"
  | "tok-plain";

export interface Token {
  text: string;
  cls: TokenClass;
}

const KEYWORDS = new Set([
  // JS / TS
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "function",
  "const",
  "let",
  "var",
  "new",
  "class",
  "extends",
  "super",
  "import",
  "from",
  "export",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "typeof",
  "instanceof",
  "in",
  "of",
  "delete",
  "void",
  "yield",
  "static",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  // Python
  "def",
  "lambda",
  "pass",
  "with",
  "as",
  "not",
  "and",
  "or",
  "is",
  "self",
  "print",
  "None",
  "True",
  "False",
  // C / C++ / Rust / Go
  "int",
  "float",
  "str",
  "bool",
  "char",
  "struct",
  "pub",
  "fn",
  "match",
  "mut",
  "impl",
  "use",
  "include",
  "define",
  "public",
  "private",
  "protected",
  "readonly",
]);

function tokenizeLine(line: string): Token[] {
  const toks: Token[] = [];
  let plain = "";

  const push = (text: string, cls: TokenClass): void => {
    if (text) toks.push({ text, cls });
  };
  const flushPlain = (): void => {
    if (plain) {
      toks.push({ text: plain, cls: "tok-plain" });
      plain = "";
    }
  };

  let i = 0;
  while (i < line.length) {
    const c = line[i];

    // Line comments: `// ...` or `# ...` (only when `#` starts the line
    // or follows whitespace, so it doesn't eat CSS ids or JS private fields).
    if (c === "/" && line[i + 1] === "/") {
      flushPlain();
      push(line.slice(i), "tok-comment");
      break;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      flushPlain();
      push(line.slice(i), "tok-comment");
      break;
    }

    // Strings: single, double, or backtick, with simple backslash escapes.
    if (c === '"' || c === "'" || c === "`") {
      flushPlain();
      let j = i + 1;
      while (j < line.length) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === c) {
          j++;
          break;
        }
        j++;
      }
      push(line.slice(i, j), "tok-string");
      i = j;
      continue;
    }

    // Numbers: decimals, optional fractional part, and 0x hex.
    if (/[0-9]/.test(c) && (i === 0 || !/[A-Za-z_$]/.test(line[i - 1]))) {
      flushPlain();
      let j = i;
      if (c === "0" && (line[j + 1] === "x" || line[j + 1] === "X")) {
        j += 2;
        while (j < line.length && /[0-9a-fA-F]/.test(line[j])) j++;
      } else {
        while (j < line.length && /[0-9]/.test(line[j])) j++;
        if (line[j] === ".") {
          j++;
          while (j < line.length && /[0-9]/.test(line[j])) j++;
        }
      }
      push(line.slice(i, j), "tok-number");
      i = j;
      continue;
    }

    // Words: keywords are tagged, everything else stays plain.
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < line.length && /[A-Za-z0-9_$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      if (KEYWORDS.has(word)) {
        flushPlain();
        push(word, "tok-keyword");
      } else {
        plain += word;
      }
      i = j;
      continue;
    }

    plain += c;
    i++;
  }

  flushPlain();
  return toks;
}

/**
 * Append syntax-highlighted tokens for a single line of text into `el`.
 * Text is inserted as text nodes / classed spans, so no HTML is ever
 * built from file content (no injection risk).
 */
export function appendHighlighted(el: HTMLElement, line: string): void {
  for (const tok of tokenizeLine(line)) {
    if (tok.cls === "tok-plain") {
      el.append(document.createTextNode(tok.text));
    } else {
      const span = document.createElement("span");
      span.className = tok.cls;
      span.textContent = tok.text;
      el.append(span);
    }
  }
}
