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
      description: `
        In sessions with 'mcp__acp__read' tool. Always use it instead of the 'Read' tool. The 'Read' tool is disabled.

        The offset parameter is the line to start at (omit to start at the first line)
        The limit parameter is the number of lines to read (omit to read all lines)
        `,

      inputSchema: {
        abs_path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
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
      if (!input.limit) {
        throw new Error(
          "Reading the file failed because it's too large. Try the first 10 lines",
        );
      }

      return {
        content: [
          {
            type: "text",
            text:
              content +
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
