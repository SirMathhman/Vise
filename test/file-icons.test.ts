import { describe, expect, test } from "bun:test";
import { emojiFor } from "../web/src/file-icons.ts";

describe("file icon derivation", () => {
  test("maps extensions to their category emoji", () => {
    expect(emojiFor("app.ts")).toBe("💻");
    expect(emojiFor("script.py")).toBe("💻");
    expect(emojiFor("README.md")).toBe("📝");
    expect(emojiFor("package.json")).toBe("⚙️");
    expect(emojiFor("logo.png")).toBe("🖼️");
    expect(emojiFor("movie.mp4")).toBe("🎬");
    expect(emojiFor("bundle.zip")).toBe("📦");
    expect(emojiFor("font.woff2")).toBe("🔤");
  });

  test("folds the extension to lowercase", () => {
    expect(emojiFor("README.MD")).toBe("📝");
    expect(emojiFor("APP.TS")).toBe("💻");
  });

  test("takes the last extension for multi-dot names", () => {
    expect(emojiFor("archive.tar.gz")).toBe("📦");
    expect(emojiFor("min.js.map")).toBe("📄");
  });

  test("treats a leading dot as no extension (hidden file)", () => {
    expect(emojiFor(".gitignore")).toBe("📄");
    expect(emojiFor(".envrc")).toBe("📄");
  });

  test("falls back to the generic file emoji", () => {
    expect(emojiFor("Makefile")).toBe("📄");
    expect(emojiFor("noext")).toBe("📄");
    expect(emojiFor("data.xyz")).toBe("📄");
  });
});