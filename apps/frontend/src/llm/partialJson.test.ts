import {
  extractPartialJsonNumber,
  extractPartialJsonString,
} from "./partialJson.js";

describe("extractPartialJsonString", () => {
  it("returns '' when the key hasn't appeared yet", () => {
    expect(extractPartialJsonString('{"path":"a.t', "content")).toBe("");
  });

  it("returns '' when the key is entirely absent", () => {
    expect(extractPartialJsonString('{"path":"a.ts"}', "content")).toBe("");
  });

  it("returns the in-progress value while it is still streaming in", () => {
    expect(
      extractPartialJsonString('{"path":"a.ts","content":"hello wor', "content")
    ).toBe("hello wor");
  });

  it("stops at the unescaped closing quote, ignoring trailing JSON", () => {
    expect(
      extractPartialJsonString(
        '{"path":"a.ts","content":"hello","start_line":1}',
        "content"
      )
    ).toBe("hello");
  });

  it("decodes common escape sequences", () => {
    expect(
      extractPartialJsonString(
        String.raw`{"content":"line1\nline2\ttabbed \"quoted\" back\\slash"`,
        "content"
      )
    ).toBe('line1\nline2\ttabbed "quoted" back\\slash');
  });

  it("decodes a complete \\u escape", () => {
    expect(
      extractPartialJsonString(String.raw`{"content":"AB"`, "content")
    ).toBe("AB");
  });

  it("holds back a trailing incomplete escape rather than mangling it", () => {
    // A lone trailing backslash: more of the escape may still be streaming in.
    expect(extractPartialJsonString('{"content":"abc\\', "content")).toBe(
      "abc"
    );
    // An incomplete \u escape (only 2 of 4 hex digits so far).
    expect(
      extractPartialJsonString(String.raw`{"content":"abc\u12`, "content")
    ).toBe("abc");
  });

  it("does not false-match a key that is a substring of another key", () => {
    expect(
      extractPartialJsonString('{"mycontent":"nope","content":"yes"', "content")
    ).toBe("yes");
  });

  it("tolerates whitespace around the colon", () => {
    expect(extractPartialJsonString('{"content"  :   "hi"', "content")).toBe(
      "hi"
    );
  });
});

describe("extractPartialJsonNumber", () => {
  it("extracts an integer value followed by a comma", () => {
    expect(
      extractPartialJsonNumber('{"start_line":42,"end_line":50}', "start_line")
    ).toBe(42);
  });

  it("extracts an integer value that closes the object", () => {
    expect(extractPartialJsonNumber('{"start_line":42}', "start_line")).toBe(
      42
    );
  });

  it("returns undefined when the key is absent", () => {
    expect(
      extractPartialJsonNumber('{"start_line":42}', "end_line")
    ).toBeUndefined();
  });

  it("returns undefined while the digits are still streaming in (no trailing delimiter yet)", () => {
    // Only "1" of an eventual "12" has arrived so far — must not read as 1.
    expect(
      extractPartialJsonNumber('{"start_line":1', "start_line")
    ).toBeUndefined();
  });
});
