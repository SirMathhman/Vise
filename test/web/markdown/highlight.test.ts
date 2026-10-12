import { expect, test } from "bun:test";
import { Marked } from "marked";
import {
  codeRenderer,
  highlightCode,
  HIGHLIGHT_MAX_CHARS,
  languageFor,
  languageOfPath,
} from "../../../packages/frontend/src/highlight.ts";

const render = (source: string): string =>
  new Marked({ renderer: { code: codeRenderer } }).parse(source, { async: false }) as string;

test("a fenced block in a known language comes out as coloured token spans", () => {
  const html = render("```ts\nconst answer: number = 42; // done\n```");
  expect(html).toContain('<pre><code class="hljs language-ts">');
  expect(html).toContain("hljs-keyword");
  expect(html).toContain("hljs-number");
  expect(html).toContain("hljs-comment");
});

test("aliases and an info string with extra words still pick the language", () => {
  expect(render("```sh title=run\necho hi\n```")).toContain("hljs-");
  expect(render("```JSON\n{\"a\": 1}\n```")).toContain("language-json");
  expect(render("```ps1\nGet-ChildItem\n```")).toContain("language-ps1");
});

test("an unknown language or none at all is left as plain escaped text", () => {
  for (const source of ["```rust\nfn main() {}\n```", "```\nconst x = 1;\n```"]) {
    const html = render(source);
    expect(html).not.toContain("hljs");
    expect(html).toContain("<pre><code");
  }
});

test("code is escaped, never interpreted as markup", () => {
  const html = render("```html\n<script>alert(1)</script>\n```");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;");
  expect(highlightCode("const s = '<img src=x onerror=alert(1)>';", "ts")).not.toContain("<img");
});

test("a very large file is not highlighted", () => {
  expect(highlightCode("x".repeat(HIGHLIGHT_MAX_CHARS + 1), "ts")).toBeUndefined();
});

test("a file's language comes from its extension, and plain files have none", () => {
  expect(languageOfPath("src/app.ts")).toBe("ts");
  expect(languageOfPath("web\\src\\View.tsx")).toBe("typescript");
  expect(languageOfPath("config.json")).toBe("json");
  expect(languageOfPath("index.html")).toBe("xml");
  expect(languageOfPath("run.ps1")).toBe("powershell");
  expect(languageOfPath("styles/main.css")).toBe("css");
  expect(languageOfPath("notes.txt")).toBeUndefined();
  expect(languageOfPath("Makefile")).toBeUndefined();
  expect(languageOfPath(".gitignore")).toBeUndefined();
  expect(languageFor("klingon")).toBeUndefined();
});
