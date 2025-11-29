import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionLoader } from "../session-loader.js";
import { Logger } from "../acp-agent.js";
import path from "node:path";

// Mock the external dependencies
vi.mock("node:os", () => ({
  homedir: () => "/home/user",
}));

const mockFs = new Map<string, string>();
vi.mock("node:fs/promises", () => ({
  readFile: async (filePath: string) => {
    if (mockFs.has(filePath)) {
      return mockFs.get(filePath);
    }
    throw new Error(`File not found: ${filePath}`);
  },
}));

describe("SessionLoader", () => {
  let logger: Logger;

  beforeEach(() => {
    logger = {
      log: vi.fn(),
      error: vi.fn(),
    };
    mockFs.clear();
  });

  it("should load a session successfully", async () => {
    const sessionId = "test-session";
    const cwd = "/path/to/project";
    const projectName = "project";
    const sessionPath = path.join(
      "/home/user",
      ".claude",
      "projects",
      projectName,
      `${sessionId}.jsonl`,
    );

    const sessionData = [
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
        permissionMode: "default",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      },
    ].map((m) => JSON.stringify(m));

    mockFs.set(sessionPath, sessionData.join("\n"));

    const sessionLoader = new SessionLoader(logger);
    const result = await sessionLoader.loadSession(sessionId, cwd);

    expect(result).not.toBeNull();
    expect(result?.messages).toHaveLength(2);
    expect(result?.messages[0].type).toBe("user");
    expect(result?.options.cwd).toBe(cwd);
    expect(result?.options.permissionMode).toBe("default");
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("should return null if session file not found", async () => {
    const sessionId = "non-existent-session";
    const cwd = "/path/to/project";

    const sessionLoader = new SessionLoader(logger);
    const result = await sessionLoader.loadSession(sessionId, cwd);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalled();
  });

  it("should return null for an empty session file", async () => {
    const sessionId = "empty-session";
    const cwd = "/path/to/project";
    const projectName = "project";
    const sessionPath = path.join(
      "/home/user",
      ".claude",
      "projects",
      projectName,
      `${sessionId}.jsonl`,
    );

    mockFs.set(sessionPath, "");

    const sessionLoader = new SessionLoader(logger);
    const result = await sessionLoader.loadSession(sessionId, cwd);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      `[claude-code-acp] Session file is empty: ${sessionPath}`,
    );
  });

  it("should return null for a session file with invalid JSON", async () => {
    const sessionId = "invalid-json-session";
    const cwd = "/path/to/project";
    const projectName = "project";
    const sessionPath = path.join(
      "/home/user",
      ".claude",
      "projects",
      projectName,
      `${sessionId}.jsonl`,
    );

    mockFs.set(sessionPath, "this is not json");

    const sessionLoader = new SessionLoader(logger);
    const result = await sessionLoader.loadSession(sessionId, cwd);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("[claude-code-acp] Error loading session:"),
    );
  });

  it("should return null for a session file with a mix of valid and invalid JSON", async () => {
    const sessionId = "mixed-json-session";
    const cwd = "/path/to/project";
    const projectName = "project";
    const sessionPath = path.join(
      "/home/user",
      ".claude",
      "projects",
      projectName,
      `${sessionId}.jsonl`,
    );

    const validJson = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Hello" }] },
    });
    mockFs.set(sessionPath, `${validJson}\nthis is not json`);

    const sessionLoader = new SessionLoader(logger);
    const result = await sessionLoader.loadSession(sessionId, cwd);

    expect(result).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("[claude-code-acp] Error loading session:"),
    );
  });

  it("should use default permissionMode if not specified", async () => {
    const sessionId = "default-permission-session";
    const cwd = "/path/to/project";
    const projectName = "project";
    const sessionPath = path.join(
      "/home/user",
      ".claude",
      "projects",
      projectName,
      `${sessionId}.jsonl`,
    );

    const sessionData = [
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
        // permissionMode is omitted
      },
    ].map((m) => JSON.stringify(m));

    mockFs.set(sessionPath, sessionData.join("\n"));

    const sessionLoader = new SessionLoader(logger);
    const result = await sessionLoader.loadSession(sessionId, cwd);

    expect(result).not.toBeNull();
    expect(result?.options.permissionMode).toBe("default");
    expect(logger.error).not.toHaveBeenCalled();
  });
});
