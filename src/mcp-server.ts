import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Server } from "node:http";
import { ClaudeAcpAgent } from "./acp-agent.js";

export function createMcpServer(
  agent: ClaudeAcpAgent,
  sessionId: string,
): Promise<Server> {
  // Create MCP server
  const server = new McpServer({
    name: "acp-mcp-server",
    version: "1.0.0",
  });

  // Register a simple echo tool (for demonstration)
  server.registerTool(
    "permission",
    {
      title: "Permission Tool",
      description: "Used to request tool permissions",
      inputSchema: {
        tool_name: z.string(),
        input: z.any(),
        tool_use_id: z.string().optional(),
      },
    },
    async (input) => {
      console.error("PERMISSION TOOl", input);
      const session = agent.sessions[sessionId];
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                behavior: "deny",
                message: "Session not found",
              }),
            },
          ],
        };
      }
      let response = await agent.client.requestPermission({
        options: [
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" },
        ],
        sessionId,
        toolCall: {
          toolCallId: input.tool_use_id!,
          rawInput: input.input,
        },
      });
      if (
        response.outcome?.outcome == "selected" &&
        response.outcome.optionId == "allow"
      ) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                behavior: "allow",
                updatedInput: input.input,
              }),
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                behavior: "deny",
                message: "User refused permission to run tool",
              }),
            },
          ],
        };
      }
    },
  );

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    try {
      const transport: StreamableHTTPServerTransport =
        new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });

  return new Promise((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", (error) => {
      if (error) {
        reject(error);
        return;
      }
      const address = listener.address();
      console.error(address);
      if (typeof address === "object" && address && "port" in address) {
        console.error(
          `MCP HTTP server listening on http://127.0.0.1:${address.port}/mcp`,
        );
      }
      resolve(listener);
    });
  });
}
