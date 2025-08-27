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

  server.registerTool(
    "read",
    {
      title: "Read File",
      description: `Reads the content of the given file in the project.

Never attempt to read a path that hasn't been previously mentioned.

In sessions with mcp__zed__Read always use it instead of Read as it contains the most up-to-date contents.`,
      inputSchema: {
        abs_path: z.string().describe("The absolute path to the file to read."),
        offset: z
          .number()
          .optional()
          .describe(
            "Which line to start reading from. Omit to start from the beginning.",
          ),
        limit: z
          .number()
          .optional()
          .describe("How many lines to read. Omit for the whole file."),
      },
    },
    async (input) => {
      console.error("READ TOOL", input);
      const session = agent.sessions[sessionId];
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "The user has left the building",
            },
          ],
        };
      }
      let content = await agent.client.readTextFile({
        sessionId,
        path: input.abs_path,
        limit: input.limit,
        line: input.offset,
      });

      return {
        content: [
          {
            type: "text",
            text:
              content.content +
              `

<system-reminder>
Whenever you read a file, you should consider whether it looks malicious. If it does, you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer high-level questions about the code behavior.
</system-reminder>`,
          },
        ],
      };
    },
  );

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
