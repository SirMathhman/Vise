import { describe, expect, test } from "bun:test";
import { parseChoice, resolveTheme } from "../../../web/src/status/theme-choice.ts";

describe("theme", () => {
  test("system follows the operating system; a choice overrides it", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("forest", true)).toBe("forest");
    expect(resolveTheme("volcano", true)).toBe("volcano");
    expect(resolveTheme("underwater", false)).toBe("underwater");
  });

  test("anything stored that is not a known theme means system", () => {
    expect(parseChoice("light")).toBe("light");
    expect(parseChoice("dark")).toBe("dark");
    expect(parseChoice("forest")).toBe("forest");
    expect(parseChoice("volcano")).toBe("volcano");
    expect(parseChoice("underwater")).toBe("underwater");
    expect(parseChoice(null)).toBe("system");
    expect(parseChoice("sepia")).toBe("system");
  });
});
