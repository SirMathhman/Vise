import { buildDiffRows, clampEditRange } from "./diff.js";

describe("clampEditRange", () => {
  it("passes through a range that already fits", () => {
    expect(clampEditRange(2, 4, 10)).toEqual({ start: 2, end: 4 });
  });

  it("clamps end_line to lineCount + 1 when it runs past the file", () => {
    expect(clampEditRange(2, 100, 5)).toEqual({ start: 2, end: 6 });
  });

  it("never lets end drop below start", () => {
    expect(clampEditRange(5, 1, 10)).toEqual({ start: 5, end: 5 });
  });
});

describe("buildDiffRows", () => {
  const lines = ["one", "two", "three", "four", "five"];

  it("marks the replaced range removed and the replacement added, with unchanged context around it", () => {
    const rows = buildDiffRows(lines, 2, 4, ["TWO'", "TWO''"]);
    expect(rows).toEqual([
      { oldNum: 1, newNum: 1, marker: "", text: "one" },
      { oldNum: 2, newNum: null, marker: "-", text: "two" },
      { oldNum: 3, newNum: null, marker: "-", text: "three" },
      { oldNum: null, newNum: 2, marker: "+", text: "TWO'" },
      { oldNum: null, newNum: 3, marker: "+", text: "TWO''" },
      // Context after the hunk shifts by (2 added - 2 removed) = 0 here.
      { oldNum: 4, newNum: 4, marker: "", text: "four" },
      { oldNum: 5, newNum: 5, marker: "", text: "five" },
    ]);
  });

  it("shifts trailing context line numbers when the replacement changes line count", () => {
    // Replace 1 line (line 2) with 3 lines: net +2.
    const rows = buildDiffRows(lines, 2, 3, ["a", "b", "c"]);
    const trailing = rows.filter((r) => r.oldNum !== null && r.oldNum >= 3);
    expect(trailing).toEqual([
      { oldNum: 3, newNum: 5, marker: "", text: "three" },
      { oldNum: 4, newNum: 6, marker: "", text: "four" },
      { oldNum: 5, newNum: 7, marker: "", text: "five" },
    ]);
  });

  it("renders a pure insertion (start_line === end_line) with no removed rows", () => {
    const rows = buildDiffRows(lines, 3, 3, ["NEW"]);
    expect(rows.filter((r) => r.marker === "-")).toEqual([]);
    expect(rows.filter((r) => r.marker === "+")).toEqual([
      { oldNum: null, newNum: 3, marker: "+", text: "NEW" },
    ]);
  });

  it("renders an empty added side while content is still streaming in", () => {
    const rows = buildDiffRows(lines, 2, 4, []);
    expect(rows.filter((r) => r.marker === "+")).toEqual([]);
    expect(rows.filter((r) => r.marker === "-")).toHaveLength(2);
  });
});
