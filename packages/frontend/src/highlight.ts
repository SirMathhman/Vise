import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * Syntax highlighting for the page: model code blocks and the file viewer.
 * Only the languages registered here are in the bundle (the core is small,
 * each pack a few KB); any other language is shown as plain text. highlight.js
 * knows each pack's aliases (`ts`, `js`, `html`, `sh`, `ps1`, `yml`, `py`...).
 * The colours are `--code-*` tokens (`web/styles/code.css`), per theme.
 */
const LANGUAGES = {
  bash,
  css,
  diff,
  javascript,
  json,
  powershell,
  python,
  sql,
  typescript,
  xml,
  yaml,
};
for (const [name, pack] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, pack);

/** Files larger than this are shown plain: highlighting runs on the page's thread, per render. */
export const HIGHLIGHT_MAX_CHARS = 200_000;

/** `name` (a language id or alias such as `ts`, `sh`, `yml`) when it is one of ours; undefined otherwise. */
export function languageFor(name: string | undefined): string | undefined {
  const lower = name?.trim().toLowerCase();
  return lower && hljs.getLanguage(lower) ? lower : undefined;
}

/** File extensions that name a language other than their own word. */
const EXTENSIONS: Record<string, string> = {
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  htm: "xml",
  html: "xml",
  svg: "xml",
  xhtml: "xml",
  vue: "xml",
  ps1: "powershell",
  psm1: "powershell",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  py: "python",
  patch: "diff",
};

/** The highlight language of a file path (by extension), or undefined for plain text. */
export function languageOfPath(path: string): string | undefined {
  const file = path.split(/[\\/]/).pop() ?? "";
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = file.slice(dot + 1).toLowerCase();
  return EXTENSIONS[ext] ?? languageFor(ext);
}

/**
 * `code` as highlighted, HTML-escaped markup for the language, or undefined
 * when the language is not one of ours (the caller then shows it plain).
 * Never throws: a language pack that chokes on odd input means plain text.
 */
export function highlightCode(code: string, language: string | undefined): string | undefined {
  const id = languageFor(language);
  if (id === undefined || code.length > HIGHLIGHT_MAX_CHARS) return undefined;
  try {
    return hljs.highlight(code, { language: id, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}

/**
 * marked's `code` renderer: a fenced block in a language we know becomes
 * highlighted markup; anything else returns `false`, which hands the block back
 * to marked's own rendering (escaped, no colours). highlight.js escapes the
 * text itself, and its spans carry only classes, which the sanitizer keeps.
 */
export function codeRenderer({ text, lang }: { text: string; lang?: string }): string | false {
  const language = languageFor((lang ?? "").split(/\s+/)[0]);
  const html = highlightCode(text, language);
  if (html === undefined) return false;
  return `<pre><code class="hljs language-${language}">${html}</code></pre>\n`;
}
