import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFile } from "../../src/tools/files.ts";

function fileWith(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "edit-eol-")), "styles.css");
  writeFileSync(path, content, "utf8");
  return path;
}

const read = (path: string): string => readFileSync(path, "utf8");
const CRLF_CSS = ":root {\r\n  --a: 1;\r\n}\r\n\r\n* {\r\n  margin: 0;\r\n}\r\n";

describe("edit_file line endings", () => {
  test("a multi-line old_string written with newlines matches a CRLF file, which stays CRLF", () => {
    const path = fileWith(CRLF_CSS);
    const result = editFile({
      path,
      old_string: "  --a: 1;\n}\n\n* {",
      new_string: "  --a: 1;\n  --b: 2;\n}\n\n* {",
    });
    expect(result).toBe(`edited ${path}`);
    expect(read(path)).toBe(
      ":root {\r\n  --a: 1;\r\n  --b: 2;\r\n}\r\n\r\n* {\r\n  margin: 0;\r\n}\r\n",
    );
  });

  test("lines added by a single-line match get CRLF too, so the file never ends up mixed", () => {
    const path = fileWith(CRLF_CSS);
    editFile({ path, old_string: "--a: 1;", new_string: "--a: 1;\n  --b: 2;" });
    const text = read(path);
    expect(text).toContain("--a: 1;\r\n  --b: 2;\r\n}");
    expect(text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  test("an old_string that already has CRLF still matches", () => {
    const path = fileWith(CRLF_CSS);
    editFile({ path, old_string: "--a: 1;\r\n}", new_string: "--a: 2;\r\n}" });
    expect(read(path)).toBe(CRLF_CSS.replace("--a: 1;", "--a: 2;"));
  });

  test("a file with LF line endings is edited exactly as before", () => {
    const path = fileWith(CRLF_CSS.replaceAll("\r\n", "\n"));
    editFile({ path, old_string: "--a: 1;\n}", new_string: "--a: 1;\n  --b: 2;\n}" });
    const text = read(path);
    expect(text).toContain("--a: 1;\n  --b: 2;\n}");
    expect(text).not.toContain("\r");
  });

  test("replacement text is written as given, without `$` patterns being expanded", () => {
    for (const text of [CRLF_CSS, CRLF_CSS.replaceAll("\r\n", "\n")]) {
      const path = fileWith(text);
      editFile({ path, old_string: "margin: 0;", new_string: "content: \"echo $& $' $$ $1 $`\";" });
      expect(read(path)).toContain("content: \"echo $& $' $$ $1 $`\";");
    }
  });

  test("text that is not in the file is still reported", () => {
    const path = fileWith(CRLF_CSS);
    expect(editFile({ path, old_string: "nope\nnope", new_string: "x" })).toBe(
      `error: old_string not found in ${path}`,
    );
  });
});
