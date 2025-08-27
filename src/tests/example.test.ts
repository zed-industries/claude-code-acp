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

describe("ACP subprocess integration", () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    // Start the subprocess
    child = spawn("npm", ["run", "dev"], {
      stdio: ["pipe", "pipe", "pipe"],
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
      console.log(params);
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
      nodeToWebReadable(child.stdout!) as any,
    );

    let session = await connection.newSession({ cwd: "./", mcpServers: [] });
    await connection.prompt({
      prompt: [{ type: "text", text: "Hello Claude!" }],
      sessionId: session.sessionId,
    });
  });
});
