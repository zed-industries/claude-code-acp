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
      title: "Read",
      description: `Reads the content of the given file in the project.

Never attempt to read a path that hasn't been previously mentioned.

In sessions with mcp__acp__read always use it instead of Read as it contains the most up-to-date contents.`,
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
      annotations: {
        title: "Read file",
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      try {
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
        let content = await agent.readTextFile({
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
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: "Reading file failed: " + error.message,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "write",
    {
      title: "Write",
      description: `Writes content to the specified file in the project.

In sessions with mcp__acp__write always use it instead of Write as it will
allow the user to conveniently review changes.`,
      inputSchema: {
        abs_path: z.string().describe("The absolute path to the file to write"),
        content: z.string().describe("The full content to write"),
      },
      annotations: {
        title: "Write file",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      try {
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
        let content = await agent.writeTextFile({
          sessionId,
          path: input.abs_path,
          content: input.content,
        });

        return {
          content: [],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: "Writing file failed: " + error.message,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "edit",
    {
      title: "Edit",
      description: `Edit a file.

In sessions with mcp__acp__edit always use it instead of Edit as it will
allow the user to conveniently review changes.

File editing instructions:
- The \`old_text\` param must match existing file content, including indentation.
- The \`old_text\` param must come from the actual file, not an outline.
- The \`old_text\` section must not be empty.
- Be minimal with replacements:
  - For unique lines, include only those lines.
  - For non-unique lines, include enough context to identify them.
- Do not escape quotes, newlines, or other characters.
- Only edit the specified file.`,
      inputSchema: {
        abs_path: z.string().describe("The absolute path to the file to read."),
        old_text: z
          .string()
          .describe("The old text to replace (must be unique in the file)"),
        new_text: z.string().describe("The new text."),
      },
      annotations: {
        title: "Edit file",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
      try {
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

        let { content } = await agent.readTextFile({
          sessionId,
          path: input.abs_path,
        });

        const { newContent, lineNumbers } = replaceAndCalculateLocation(
          content,
          [
            {
              oldText: input.old_text,
              newText: input.new_text,
              replaceAll: false,
            },
          ],
        );

        await agent.writeTextFile({
          sessionId,
          path: input.abs_path,
          content: newContent,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ lineNumbers }),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: "Editing file failed: " + error.message,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "multi-edit",
    {
      title: "Multi Edit",
      description: `Edit a file with multiple sequential edits.`,
      inputSchema: {
        file_path: z
          .string()
          .describe("The absolute path to the file to modify"),
        edits: z
          .array(
            z.object({
              old_string: z.string().describe("The text to replace"),
              new_string: z.string().describe("The text to replace it with"),
              replace_all: z
                .boolean()
                .optional()
                .describe(
                  "Replace all occurrences of old_string (default false)",
                ),
            }),
          )
          .min(1)
          .describe(
            "Array of edit operations to perform sequentially on the file",
          ),
      },
      annotations: {
        title: "Multi Edit file",
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false,
      },
    },
    async (input) => {
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

      let { content } = await agent.readTextFile({
        sessionId,
        path: input.file_path,
      });

      const { newContent, lineNumbers } = replaceAndCalculateLocation(
        content,
        input.edits.map((edit) => ({
          oldText: edit.old_string,
          newText: edit.new_string,
          replaceAll: edit.replace_all ?? false,
        })),
      );

      await agent.writeTextFile({
        sessionId,
        path: input.file_path,
        content: newContent,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ lineNumbers }),
          },
        ],
      };
    },
  );

  let alwaysAllowedTools: { [key: string]: boolean } = {};
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
      if (alwaysAllowedTools[input.tool_name]) {
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
      }
      let response = await agent.client.requestPermission({
        options: [
          {
            kind: "allow_always",
            name: "Always Allow",
            optionId: "allow_always",
          },
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
        (response.outcome.optionId == "allow" ||
          response.outcome.optionId == "allow_always")
      ) {
        if (response.outcome.optionId == "allow_always") {
          alwaysAllowedTools[input.tool_name] = true;
        }
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
      resolve(listener);
    });
  });
}

/**
 * Replace text in a file and calculate the line numbers where the edits occurred.
 *
 * @param fileContent - The full file content
 * @param edits - Array of edit operations to apply sequentially
 * @returns the new content and the line numbers where replacements occurred in the final content
 */
export function replaceAndCalculateLocation(
  fileContent: string,
  edits: Array<{
    oldText: string;
    newText: string;
    replaceAll?: boolean;
  }>,
): { newContent: string; lineNumbers: number[] } {
  let currentContent = fileContent;

  // Use unique markers to track where replacements happen
  const markerPrefix = `__REPLACE_MARKER_${Math.random().toString(36).substr(2, 9)}_`;
  let markerCounter = 0;
  const markers: string[] = [];

  // Apply edits sequentially, inserting markers at replacement positions
  for (const edit of edits) {
    // Skip empty oldText
    if (edit.oldText === "") {
      continue;
    }

    if (edit.replaceAll) {
      // Replace all occurrences with marker + newText
      const parts: string[] = [];
      let lastIndex = 0;
      let searchIndex = 0;

      while (true) {
        const index = currentContent.indexOf(edit.oldText, searchIndex);
        if (index === -1) break;

        // Add content before the match
        parts.push(currentContent.substring(lastIndex, index));

        // Add marker and replacement
        const marker = `${markerPrefix}${markerCounter++}__`;
        markers.push(marker);
        parts.push(marker + edit.newText);

        lastIndex = index + edit.oldText.length;
        searchIndex = lastIndex;
      }

      // Add remaining content
      parts.push(currentContent.substring(lastIndex));
      currentContent = parts.join("");
    } else {
      // Replace first occurrence only
      const index = currentContent.indexOf(edit.oldText);
      if (index !== -1) {
        const marker = `${markerPrefix}${markerCounter++}__`;
        markers.push(marker);
        currentContent =
          currentContent.substring(0, index) +
          marker +
          edit.newText +
          currentContent.substring(index + edit.oldText.length);
      }
    }
  }

  // Find line numbers where markers appear in the content
  const lineNumbers: number[] = [];
  for (const marker of markers) {
    const index = currentContent.indexOf(marker);
    if (index !== -1) {
      const lineNumber = Math.max(
        0,
        currentContent.substring(0, index).split(/\r\n|\r|\n/).length - 1,
      );
      lineNumbers.push(lineNumber);
    }
  }

  // Remove all markers from the final content
  let finalContent = currentContent;
  for (const marker of markers) {
    finalContent = finalContent.replace(marker, "");
  }

  // Dedupe and sort line numbers
  const uniqueLineNumbers = [...new Set(lineNumbers)].sort();

  return { newContent: finalContent, lineNumbers: uniqueLineNumbers };
}
