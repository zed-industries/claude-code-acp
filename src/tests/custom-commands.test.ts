import { describe, expect, it } from "vitest";
import { parseCommandFile, parseFrontmatter } from "../acp-agent.js";

describe("parseCommandFile", () => {
  it("should parse a command with frontmatter", () => {
    const content = `---
description: Analyze code for performance issues
argument-hint: [file-path]
allowed-tools: Read, Bash
model: claude-3-5-sonnet-20241022
---

Analyze the provided code for performance bottlenecks.`;

    const result = parseCommandFile(content, "optimize.md", "project");

    expect(result).toEqual({
      name: "optimize",
      description: "Analyze code for performance issues (project)",
      requiresArgument: true,
    });
  });

  it("should parse a command without frontmatter", () => {
    const content = `Review this code for security vulnerabilities.

Check for:
- SQL injection
- XSS risks`;

    const result = parseCommandFile(content, "security-review.md", "user");

    expect(result).toEqual({
      name: "security-review",
      description: "Review this code for security vulnerabilities. (user)",
      requiresArgument: false,
    });
  });

  it("should handle commands in subdirectories", () => {
    const content = `---
description: Generate a new React component
argument-hint: <component-name>
---

Generate a new React component.`;

    const result = parseCommandFile(
      content,
      "frontend/component.md",
      "project",
    );

    expect(result).toEqual({
      name: "component",
      description: "Generate a new React component (project:frontend)",
      requiresArgument: true,
    });
  });

  it("should handle nested subdirectories", () => {
    const content = `---
description: Run API tests
---

Execute API test suite.`;

    const result = parseCommandFile(
      content,
      "testing/api/integration.md",
      "user",
    );

    expect(result).toEqual({
      name: "integration",
      description: "Run API tests (user:testing:api)",
      requiresArgument: false,
    });
  });

  it("should use default description when none provided", () => {
    const content = `---
argument-hint: [query]
---

# This is a heading, not a description`;

    const result = parseCommandFile(content, "search.md", "project");

    expect(result).toEqual({
      name: "search",
      description: "Custom command (project)",
      requiresArgument: true,
    });
  });

  it("should detect requiresArgument from argument-hint presence", () => {
    const withHint = `---
description: Command with args
argument-hint: [arg1] [arg2]
---

Content`;

    const withoutHint = `---
description: Command without args
---

Content`;

    const result1 = parseCommandFile(withHint, "cmd1.md", "project");
    const result2 = parseCommandFile(withoutHint, "cmd2.md", "project");

    expect(result1?.requiresArgument).toBe(true);
    expect(result2?.requiresArgument).toBe(false);
  });

  it("should handle empty argument-hint", () => {
    const content = `---
description: Test command
argument-hint:
---

Content`;

    const result = parseCommandFile(content, "test.md", "project");

    expect(result?.requiresArgument).toBe(false);
  });

  it("should handle malformed content gracefully", () => {
    const content = "";
    const result = parseCommandFile(content, "empty.md", "project");

    expect(result).toEqual({
      name: "empty",
      description: "Custom command (project)",
      requiresArgument: false,
    });
  });
});

describe("parseFrontmatter", () => {
  it("should parse valid frontmatter", () => {
    const content = `---
description: Test description
argument-hint: [arg]
model: claude-3-5-sonnet
allowed-tools: Read, Write
---

Content after frontmatter`;

    const result = parseFrontmatter(content);

    expect(result).toEqual({
      description: "Test description",
      "argument-hint": "[arg]",
      model: "claude-3-5-sonnet",
      "allowed-tools": "Read, Write",
    });
  });

  it("should handle content without frontmatter", () => {
    const content = `This is just regular content
without any frontmatter`;

    const result = parseFrontmatter(content);

    expect(result).toEqual({});
  });

  it("should handle empty frontmatter", () => {
    const content = `---
---

Content`;

    const result = parseFrontmatter(content);

    expect(result).toEqual({});
  });

  it("should handle frontmatter with colons in values", () => {
    const content = `---
description: Command: do something
url: https://example.com:8080/path
---

Content`;

    const result = parseFrontmatter(content);

    expect(result).toEqual({
      description: "Command: do something",
      url: "https://example.com:8080/path",
    });
  });

  it("should ignore invalid frontmatter lines", () => {
    const content = `---
valid-key: value
invalid line without colon
another-key: another value
---

Content`;

    const result = parseFrontmatter(content);

    expect(result).toEqual({
      "valid-key": "value",
      "another-key": "another value",
    });
  });

  it("should stop at closing delimiter", () => {
    const content = `---
key1: value1
key2: value2
---
key3: value3
This should not be parsed as frontmatter`;

    const result = parseFrontmatter(content);

    expect(result).toEqual({
      key1: "value1",
      key2: "value2",
    });
  });

  it("should handle frontmatter with empty values", () => {
    const content = `---
key1:
key2:
key3: value3
---

Content`;

    const result = parseFrontmatter(content);

    expect(result).toEqual({
      key1: "",
      key2: "",
      key3: "value3",
    });
  });

  it("should handle frontmatter without closing delimiter", () => {
    const content = `---
key1: value1
key2: value2

This looks like content but there's no closing delimiter`;

    const result = parseFrontmatter(content);

    // Should parse until end of content since no closing delimiter found
    expect(result).toEqual({
      key1: "value1",
      key2: "value2",
    });
  });

  it("should trim whitespace from keys and values", () => {
    const content = `---
  key1  :  value1
key2:     value2
   key3   :value3
---

Content`;

    const result = parseFrontmatter(content);

    expect(result).toEqual({
      key1: "value1",
      key2: "value2",
      key3: "value3",
    });
  });
});
