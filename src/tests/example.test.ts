import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import {
  Agent,
  AgentSideConnection,
  Client,
  ClientSideConnection,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@zed-industries/agent-client-protocol";
import { nodeToWebWritable, nodeToWebReadable } from "../utils.js";
import { toolContent, toolKind, toolLabel } from "../tools.js";
import { toAcpNotifications } from "../acp-agent.js";
import { UUID } from "crypto";
import { SDKAssistantMessage } from "@anthropic-ai/claude-code";

describe("ACP subprocess integration", () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    // Start the subprocess
    child = spawn("npm", ["run", "--silent", "dev"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
  });

  afterAll(() => {
    child.kill();
  });

  class TestClient implements Client {
    agent: Agent;

    constructor(agent: Agent) {
      this.agent = agent;
    }
    requestPermission(
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      throw new Error("Method not implemented.");
    }
    async sessionUpdate(params: SessionNotification): Promise<void> {
      console.error(params);
    }
    writeTextFile(
      params: WriteTextFileRequest,
    ): Promise<WriteTextFileResponse> {
      throw new Error("Method not implemented.");
    }
    readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      throw new Error("Method not implemented.");
    }
  }

  it("should connect to the ACP subprocess", async () => {
    const connection = new ClientSideConnection(
      (agent) => {
        return new TestClient(agent);
      },
      nodeToWebWritable(child.stdin!),
      nodeToWebReadable(child.stdout!),
    );

    let session = await connection.newSession({ cwd: "./", mcpServers: [] });
    await connection.prompt({
      prompt: [{ type: "text", text: "Hello Claude!" }],
      sessionId: session.sessionId,
    });
  });
});

describe("tool conversions", () => {
  it("should handle Bash nicely", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01VtsS2mxUFwpBJZYd7BmbC9",
      name: "Bash",
      input: {
        command: "rm README.md.rm",
        description: "Delete README.md.rm file",
      },
    };

    expect(toolKind(tool_use.name)).toBe("execute");
    expect(toolLabel(tool_use)).toBe("rm README.md.rm");
    expect(toolContent(tool_use)).toStrictEqual([
      {
        content: {
          text: "Delete README.md.rm file",
          type: "text",
        },
        type: "content",
      },
    ]);
  });

  it("should handle plan entries", () => {
    const received: SDKAssistantMessage = {
      type: "assistant",
      message: {
        id: "msg_017eNosJgww7F5qD4a8BcAcx",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "toolu_01HaXZ4LfdchSeSR8ygt4zyq",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "Analyze existing test coverage and identify gaps",
                  status: "in_progress",
                  activeForm: "Analyzing existing test coverage",
                },
                {
                  content: "Add comprehensive edge case tests",
                  status: "pending",
                  activeForm: "Adding comprehensive edge case tests",
                },
                {
                  content: "Add performance and timing tests",
                  status: "pending",
                  activeForm: "Adding performance and timing tests",
                },
                {
                  content: "Add error handling and panic behavior tests",
                  status: "pending",
                  activeForm: "Adding error handling tests",
                },
                {
                  content: "Add concurrent access and race condition tests",
                  status: "pending",
                  activeForm: "Adding concurrent access tests",
                },
                {
                  content:
                    "Add tests for Each function with various data types",
                  status: "pending",
                  activeForm: "Adding Each function tests",
                },
                {
                  content: "Add benchmark tests for performance measurement",
                  status: "pending",
                  activeForm: "Adding benchmark tests",
                },
                {
                  content: "Improve test organization and helper functions",
                  status: "pending",
                  activeForm: "Improving test organization",
                },
              ],
            },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 6,
          cache_creation_input_tokens: 326,
          cache_read_input_tokens: 17265,
          cache_creation: {
            ephemeral_5m_input_tokens: 326,
            ephemeral_1h_input_tokens: 0,
          },
          output_tokens: 1,
          service_tier: "standard",
        },
      },
      parent_tool_use_id: null,
      session_id: "d056596f-e328-41e9-badd-b07122ae5227",
      uuid: "b7c3330c-de8f-4bba-ac53-68c7f76ffeb5",
    };
    expect(toAcpNotifications(received, "test")).toStrictEqual([
      {
        sessionId: "test",
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Analyze existing test coverage and identify gaps",
              priority: "medium",
              status: "in_progress",
            },
            {
              content: "Add comprehensive edge case tests",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add performance and timing tests",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add error handling and panic behavior tests",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add concurrent access and race condition tests",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add tests for Each function with various data types",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add benchmark tests for performance measurement",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Improve test organization and helper functions",
              priority: "medium",
              status: "pending",
            },
          ],
        },
      },
    ]);
  });
});
