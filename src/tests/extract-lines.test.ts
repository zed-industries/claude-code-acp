import { describe, it, expect } from "vitest";
import { extractLinesWithByteLimit } from "../utils.js";

describe("extractLinesWithByteLimit", () => {
  const simpleContent = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";

  it("should extract all lines when under byte limit", () => {
    const result = extractLinesWithByteLimit(simpleContent, 1000);

    expect(result.content).toBe(simpleContent);
    expect(result.wasLimited).toBe(false);
    expect(result.linesRead).toBe(5);
  });

  it("should limit output when exceeding byte limit", () => {
    // Create content that will exceed byte limit
    const longLine = "x".repeat(100);
    const manyLines = Array(10).fill(longLine).join("\n");

    const result = extractLinesWithByteLimit(manyLines, 250);

    expect(result.wasLimited).toBe(true);
    expect(result.linesRead).toBe(2);
  });

  it("should handle empty content", () => {
    const result = extractLinesWithByteLimit("", 1000);

    expect(result.content).toBe("");
    expect(result.wasLimited).toBe(false);
    expect(result.linesRead).toBe(1); // We read the one empty line
  });

  it("should handle single line file", () => {
    const singleLine = "This is a single line without newline";
    const result = extractLinesWithByteLimit(singleLine, 1000);

    expect(result.content).toBe(singleLine);
    expect(result.wasLimited).toBe(false);
    expect(result.linesRead).toBe(1);
  });

  it("should correctly count bytes with multi-byte characters", () => {
    const unicodeContent = "Hello 世界\n你好 World\nEmoji: 🌍\nNormal line";
    const result = extractLinesWithByteLimit(unicodeContent, 1000);

    expect(result.content).toBe(unicodeContent);
    expect(result.linesRead).toBe(4);
  });

  it("should stop at byte limit even with one more line available", () => {
    // Create lines where adding one more would exceed limit
    const line1 = "a".repeat(40);
    const line2 = "b".repeat(40);
    const line3 = "c".repeat(40);
    const content = `${line1}\n${line2}\n${line3}`;

    const result = extractLinesWithByteLimit(content, 85);

    expect(result.content).toBe(`${line1}\n${line2}\n`);
    expect(result.wasLimited).toBe(true);
    expect(result.linesRead).toBe(2);
  });

  it("should read exactly to limit when possible", () => {
    const exactContent = "12345\n67890\n12345"; // 17 bytes total
    const result = extractLinesWithByteLimit(exactContent, 17);

    expect(result.content).toBe(exactContent);
    expect(result.wasLimited).toBe(false);
    expect(result.linesRead).toBe(3);
  });

  it("should handle Windows-style line endings", () => {
    const windowsContent = "Line 1\r\nLine 2\r\nLine 3";
    const result = extractLinesWithByteLimit(windowsContent, 1000);

    // Note: split("\n") will keep the \r characters
    expect(result.content).toBe("Line 1\r\nLine 2\r\nLine 3");
    expect(result.linesRead).toBe(3);
  });

  it("should handle very large files efficiently", () => {
    // Create a 100KB file
    const largeLine = "x".repeat(1000);
    const largeContent = Array(110).fill(largeLine).join("\n");

    const result = extractLinesWithByteLimit(largeContent, 50000);

    expect(result.wasLimited).toBe(true);
  });

  it("should allow at least one line even if it exceeds byte limit", () => {
    const veryLongLine = "x".repeat(100000); // 100KB line
    const result = extractLinesWithByteLimit(veryLongLine, 50000);

    // Should return the line even though it exceeds the byte limit
    // because we always allow at least one line if no lines have been added yet
    expect(result.content).toBe(veryLongLine);
    expect(result.linesRead).toBe(1);
    expect(result.wasLimited).toBe(false);
  });
});
