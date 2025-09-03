import { describe, it, expect } from "vitest";
import { replaceAndCalculateLocation } from "../mcp-server.js";

describe("replaceAndCalculateLocation", () => {
  it("should replace first occurrence and return correct line number", () => {
    const content = "line 1\nline 2 with text\nline 3 with text\nline 4";
    const result = replaceAndCalculateLocation(content, [{ oldText: "text", newText: "replaced" }]);

    expect(result.newContent).toBe("line 1\nline 2 with replaced\nline 3 with text\nline 4");
    expect(result.lineNumbers).toEqual([1]); // Line 2 (0-based indexing)
  });

  it("should replace all occurrences when replaceAll is true", () => {
    const content = "line 1\nline 2 with text\nline 3 with text\nline 4";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "text", newText: "replaced", replaceAll: true },
    ]);

    expect(result.newContent).toBe("line 1\nline 2 with replaced\nline 3 with replaced\nline 4");
    expect(result.lineNumbers).toEqual([1, 2]); // Lines 2 and 3 (0-based)
  });

  it("should return empty line numbers array when no match found", () => {
    const content = "line 1\nline 2\nline 3";
    expect(() => {
      replaceAndCalculateLocation(content, [{ oldText: "notfound", newText: "replaced" }]);
    }).toThrow('The provided `old_string` does not appear in the file: "notfound"');
  });

  it("should handle Windows line endings (CRLF)", () => {
    const content = "line 1\r\nline 2 with text\r\nline 3 with text\r\nline 4";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "text", newText: "replaced", replaceAll: true },
    ]);

    expect(result.newContent).toBe(
      "line 1\r\nline 2 with replaced\r\nline 3 with replaced\r\nline 4",
    );
    expect(result.lineNumbers).toEqual([1, 2]);
  });

  it("should handle old Mac line endings (CR)", () => {
    const content = "line 1\rline 2 with text\rline 3 with text\rline 4";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "text", newText: "replaced", replaceAll: true },
    ]);

    expect(result.newContent).toBe("line 1\rline 2 with replaced\rline 3 with replaced\rline 4");
    expect(result.lineNumbers).toEqual([1, 2]);
  });

  it("should handle mixed line endings", () => {
    const content = "line 1\nline 2 with text\r\nline 3 with text\rline 4";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "text", newText: "replaced", replaceAll: true },
    ]);

    expect(result.newContent).toBe("line 1\nline 2 with replaced\r\nline 3 with replaced\rline 4");
    expect(result.lineNumbers).toEqual([1, 2]);
  });

  it("should handle text at the beginning of file", () => {
    const content = "text at start\nline 2\nline 3";
    const result = replaceAndCalculateLocation(content, [{ oldText: "text", newText: "replaced" }]);

    expect(result.newContent).toBe("replaced at start\nline 2\nline 3");
    expect(result.lineNumbers).toEqual([0]); // First line (0-based)
  });

  it("should handle text at the end of file", () => {
    const content = "line 1\nline 2\nlast line with text";
    const result = replaceAndCalculateLocation(content, [{ oldText: "text", newText: "replaced" }]);

    expect(result.newContent).toBe("line 1\nline 2\nlast line with replaced");
    expect(result.lineNumbers).toEqual([2]); // Last line (0-based)
  });

  it("should handle multiple occurrences on the same line", () => {
    const content = "line 1\ntext text text\nline 3";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "text", newText: "replaced", replaceAll: true },
    ]);

    expect(result.newContent).toBe("line 1\nreplaced replaced replaced\nline 3");
    expect(result.lineNumbers).toEqual([1]); // All on line 2 (0-based), deduplicated
  });

  it("should handle empty file content", () => {
    expect(() => {
      replaceAndCalculateLocation("", [{ oldText: "text", newText: "replaced" }]);
    }).toThrowError(
      'The provided `old_string` does not appear in the file: "text".\n\nNo edits were applied.',
    );
  });

  it("should handle empty search text", () => {
    // Test with replaceAll false (default)
    const content1 = "line 1\nline 2\nline 3";
    expect(() => {
      replaceAndCalculateLocation(content1, [{ oldText: "", newText: "replaced" }]);
    }).toThrowError("The provided `old_string` is empty.\n\nNo edits were applied.");

    // Test with replaceAll true on single line
    const content2 = "abc";
    expect(() => {
      replaceAndCalculateLocation(content2, [{ oldText: "", newText: "X", replaceAll: true }]);
    }).toThrowError("The provided `old_string` is empty.\n\nNo edits were applied.");

    // Test with replaceAll true on multiline content
    const content3 = "ab\ncd";
    expect(() => {
      replaceAndCalculateLocation(content3, [{ oldText: "", newText: "X", replaceAll: true }]);
    }).toThrowError("The provided `old_string` is empty.\n\nNo edits were applied.");
  });

  it("should handle single line content", () => {
    const content = "single line with text here";
    const result = replaceAndCalculateLocation(content, [{ oldText: "text", newText: "replaced" }]);

    expect(result.newContent).toBe("single line with replaced here");
    expect(result.lineNumbers).toEqual([0]); // Line 1 (0-based)
  });

  it("should handle special characters in search text", () => {
    const content = "line 1\nline with $special.chars*\nline 3";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "$special.chars*", newText: "replaced" },
    ]);

    expect(result.newContent).toBe("line 1\nline with replaced\nline 3");
    expect(result.lineNumbers).toEqual([1]);
  });

  it("should handle newlines in search text", () => {
    const content = "line 1\nline 2\nline 3";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "1\nline", newText: "1\nmodified line" },
    ]);

    expect(result.newContent).toBe("line 1\nmodified line 2\nline 3");
    expect(result.lineNumbers).toEqual([0]); // Match starts at line 1 (0-based)
  });

  it("should handle newlines in replacement text", () => {
    const content = "line 1\nline 2\nline 3";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "line 2", newText: "line 2a\nline 2b" },
    ]);

    expect(result.newContent).toBe("line 1\nline 2a\nline 2b\nline 3");
    expect(result.lineNumbers).toEqual([1]);
  });

  it("should handle very long lines", () => {
    const longLine = "a".repeat(10000) + "text" + "b".repeat(10000);
    const content = `line 1\n${longLine}\nline 3`;
    const result = replaceAndCalculateLocation(content, [{ oldText: "text", newText: "replaced" }]);

    expect(result.newContent).toBe(
      `line 1\n${"a".repeat(10000)}replaced${"b".repeat(10000)}\nline 3`,
    );
    expect(result.lineNumbers).toEqual([1]);
  });

  it("should handle many lines", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    lines[500] = "line with text";
    const content = lines.join("\n");

    const result = replaceAndCalculateLocation(content, [{ oldText: "text", newText: "replaced" }]);

    expect(result.lineNumbers).toEqual([500]);
    expect(result.newContent).includes("line with replaced");
  });

  it("should handle overlapping matches correctly", () => {
    const content = "aaaa\nbbbb\ncccc";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "aa", newText: "xx", replaceAll: true },
    ]);

    // Should replace non-overlapping occurrences
    expect(result.newContent).toBe("xxxx\nbbbb\ncccc");
    expect(result.lineNumbers).toEqual([0]); // Two matches on first line, deduplicated
  });

  it("should preserve content after replacement with different lengths", () => {
    const content = "short\nmedium line\nlong line here";

    // Replacing with longer text
    const result1 = replaceAndCalculateLocation(content, [
      { oldText: "short", newText: "very very long text" },
    ]);
    expect(result1.newContent).toBe("very very long text\nmedium line\nlong line here");
    expect(result1.lineNumbers).toEqual([0]);

    // Replacing with shorter text
    const result2 = replaceAndCalculateLocation(content, [
      { oldText: "medium line", newText: "m" },
    ]);
    expect(result2.newContent).toBe("short\nm\nlong line here");
    expect(result2.lineNumbers).toEqual([1]);
  });

  it("should handle consecutive replacements", () => {
    const content = "text1 text2 text3";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "text", newText: "replaced", replaceAll: true },
    ]);

    expect(result.newContent).toBe("replaced1 replaced2 replaced3");
    expect(result.lineNumbers).toEqual([0]); // All on first line, deduplicated
  });

  it("should handle case-sensitive replacements", () => {
    const content = "Text TEXT text";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "text", newText: "replaced", replaceAll: true },
    ]);

    // Should only replace exact matches
    expect(result.newContent).toBe("Text TEXT replaced");
    expect(result.lineNumbers).toEqual([0]); // Only lowercase "text" matched
  });

  it("should handle replacement at exact end of line", () => {
    const content = "line ends with text\nnext line";
    const result = replaceAndCalculateLocation(content, [{ oldText: "text", newText: "replaced" }]);

    expect(result.newContent).toBe("line ends with replaced\nnext line");
    expect(result.lineNumbers).toEqual([0]);
  });

  it("should handle replacement spanning multiple lines", () => {
    const content = "line 1\nspan\nacross\nlines\nline 5";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "span\nacross\nlines", newText: "single" },
    ]);

    expect(result.newContent).toBe("line 1\nsingle\nline 5");
    expect(result.lineNumbers).toEqual([1]); // Match starts at line 2 (0-based)
  });

  it("should default replaceAll to false", () => {
    const content = "match match match";

    // Without passing replaceAll parameter
    const result = replaceAndCalculateLocation(content, [
      { oldText: "match", newText: "replaced" },
    ]);

    expect(result.newContent).toBe("replaced match match");
    expect(result.lineNumbers).toEqual([0]); // Only first match
  });

  it("should handle multiple edits with correct line numbers", () => {
    const content = "line 1\nfoo bar\nline 3\nfoo baz\nline 5\nbar foo\nline 7";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "foo", newText: "FOO", replaceAll: true },
      { oldText: "bar", newText: "BAR", replaceAll: false },
      { oldText: "line 3", newText: "LINE THREE" },
    ]);

    // Should replace:
    // - All "foo" occurrences (lines 1, 3, 5 in original)
    // - First "bar" occurrence (line 1 after first edit)
    // - "line 3" (line 2 after previous edits)
    expect(result.newContent).toBe("line 1\nFOO BAR\nLINE THREE\nFOO baz\nline 5\nbar FOO\nline 7");

    // Line numbers reflect position in final content, deduplicated and sorted
    expect(result.lineNumbers).toEqual([
      1, // FOO and BAR on line 1
      2, // LINE THREE on line 2
      3, // FOO on line 3
      5, // FOO on line 5
    ]);
  });

  it("should handle multiple edits with overlapping text", () => {
    const content = "hello world\nhello hello\nworld hello world";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "hello", newText: "hi", replaceAll: false },
      { oldText: "world", newText: "earth", replaceAll: true },
      { oldText: "hello", newText: "greetings", replaceAll: true },
    ]);

    // First edit replaces first "hello" only
    // Second edit replaces all "world" in the modified content
    // Third edit replaces remaining "hello"s in the modified content
    expect(result.newContent).toBe("hi earth\ngreetings greetings\nearth greetings earth");

    // Line numbers reflect position in final content, deduplicated and sorted
    expect(result.lineNumbers).toEqual([
      0, // hi and earth on line 0
      1, // greetings (multiple) on line 1
      2, // earth and greetings on line 2
    ]);
  });

  it("should handle complex scenarios with marker-like text", () => {
    // Test that our marker approach doesn't get confused by similar text
    const content = "line 1\n__MARKER__text\nline 3\n__REPLACE_MARKER_abc__\nline 5";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "__MARKER__", newText: "REPLACED", replaceAll: true },
      { oldText: "text", newText: "content" },
      { oldText: "__REPLACE_MARKER_abc__", newText: "DONE" },
    ]);

    expect(result.newContent).toBe("line 1\nREPLACEDcontent\nline 3\nDONE\nline 5");

    // Line numbers should be correct even with marker-like text
    expect(result.lineNumbers).toEqual([
      1, // REPLACED on line 1
      3, // DONE on line 3
    ]);
  });

  it("should handle edits where newText matches subsequent oldText", () => {
    const content = "foo\nbar\nbaz";
    const result = replaceAndCalculateLocation(content, [
      { oldText: "foo", newText: "bar" },
      { oldText: "bar", newText: "baz", replaceAll: true },
      { oldText: "baz", newText: "qux", replaceAll: true },
    ]);

    // First edit: foo -> bar
    // Second edit: both original bar and new bar -> baz
    // Third edit: all baz instances -> qux
    expect(result.newContent).toBe("qux\nqux\nqux");

    // All replacements end up on their respective lines
    expect(result.lineNumbers).toEqual([0, 1, 2]);
  });
});
