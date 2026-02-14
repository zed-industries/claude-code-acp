import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { encodeProjectPath } from "../utils.js";

describe("session/delete via extMethod", () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async () => { },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  function writeSessionFile(cwd: string, sessionId: string): string {
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(tempDir, "projects", encodedPath);
    fs.mkdirSync(projectDir, { recursive: true });

    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    const lines = [
      JSON.stringify({ sessionId, type: "init" }),
      JSON.stringify({
        type: "user",
        sessionId,
        cwd,
        message: { content: "Hello" },
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        cwd,
        message: { content: "Hi!" },
      }),
    ];
    fs.writeFileSync(filePath, lines.join("\n"));
    return filePath;
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-test-"));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;

    vi.resetModules();

    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    agent = new ClaudeAcpAgent(createMockClient());
  });

  afterEach(() => {
    if (originalClaudeConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("deletes an existing session file and returns deleted: true", async () => {
    const cwd = "/Users/test/project";
    const filePath = writeSessionFile(cwd, "sess-to-delete");
    expect(fs.existsSync(filePath)).toBe(true);

    const result = await agent.extMethod("session/delete", {
      sessionId: "sess-to-delete",
      cwd,
    });

    expect(result).toEqual({ deleted: true });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("returns deleted: false when session file does not exist", async () => {
    const result = await agent.extMethod("session/delete", {
      sessionId: "nonexistent",
      cwd: "/Users/test/project",
    });

    expect(result).toEqual({ deleted: false });
  });

  it("is idempotent — deleting an already-deleted session returns deleted: false", async () => {
    const cwd = "/Users/test/project";
    writeSessionFile(cwd, "sess-once");

    await agent.extMethod("session/delete", { sessionId: "sess-once", cwd });
    const result = await agent.extMethod("session/delete", {
      sessionId: "sess-once",
      cwd,
    });

    expect(result).toEqual({ deleted: false });
  });

  it("session no longer appears in listSessions after deletion", async () => {
    const cwd = "/Users/test/project";
    writeSessionFile(cwd, "sess-visible");

    const before = await agent.unstable_listSessions({ cwd });
    expect(before.sessions).toHaveLength(1);

    await agent.extMethod("session/delete", { sessionId: "sess-visible", cwd });

    const after = await agent.unstable_listSessions({ cwd });
    expect(after.sessions).toHaveLength(0);
  });

  it("throws invalidParams when sessionId is missing", async () => {
    await expect(
      agent.extMethod("session/delete", { cwd: "/Users/test/project" }),
    ).rejects.toThrow(/sessionId and cwd are required/);
  });

  it("throws invalidParams when cwd is missing", async () => {
    await expect(
      agent.extMethod("session/delete", { sessionId: "sess-123" }),
    ).rejects.toThrow(/sessionId and cwd are required/);
  });

  it("throws methodNotFound for unknown ext methods", async () => {
    await expect(
      agent.extMethod("session/unknown", { sessionId: "sess-123", cwd: "/test" }),
    ).rejects.toThrow(/session\/unknown/);
  });
});
