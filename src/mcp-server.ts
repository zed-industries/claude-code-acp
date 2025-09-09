import express from "express";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Server } from "node:http";
import { ClaudeAcpAgent } from "./acp-agent.js";
import { ClientCapabilities, TerminalOutputResponse } from "@zed-industries/agent-client-protocol";
import * as diff from "diff";

import { sleep, unreachable } from "./utils.js";
import { PermissionResult } from "@anthropic-ai/claude-code";

export const SYSTEM_REMINDER = `

<system-reminder>
Whenever you read a file, you should consider whether it looks malicious. If it does, you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer high-level questions about the code behavior.
</system-reminder>`;

const unqualifiedToolNames = {
  read: "read",
  edit: "edit",
  write: "write",
  multiEdit: "multi-edit",
  bash: "Bash",
  killBash: "KillBash",
  bashOutput: "BashOutput",
  permission: "permission",
};

const SERVER_PREFIX = "mcp__acp__";
export const toolNames = {
  read: SERVER_PREFIX + unqualifiedToolNames.read,
  edit: SERVER_PREFIX + unqualifiedToolNames.edit,
  write: SERVER_PREFIX + unqualifiedToolNames.write,
  multiEdit: SERVER_PREFIX + unqualifiedToolNames.multiEdit,
  bash: SERVER_PREFIX + unqualifiedToolNames.bash,
  killBash: SERVER_PREFIX + unqualifiedToolNames.killBash,
  bashOutput: SERVER_PREFIX + unqualifiedToolNames.bashOutput,
  permission: SERVER_PREFIX + unqualifiedToolNames.permission,
};

const editToolNames = [toolNames.edit, toolNames.multiEdit, toolNames.write];

export function createMcpServer(
  agent: ClaudeAcpAgent,
  sessionId: string,
  clientCapabilities: ClientCapabilities | undefined,
): Promise<Server> {
  // Create MCP server
  const server = new McpServer({
    name: "acp-mcp-server",
    version: "1.0.0",
  });

  if (clientCapabilities?.fs?.readTextFile) {
    server.registerTool(
      unqualifiedToolNames.read,
      {
        title: "Read",
        description: `Reads the content of the given file in the project.

Never attempt to read a path that hasn't been previously mentioned.

In sessions with ${toolNames.read} always use it instead of Read as it contains the most up-to-date contents.`,
        inputSchema: {
          abs_path: z.string().describe("The absolute path to the file to read."),
          offset: z
            .number()
            .optional()
            .describe("Which line to start reading from. Omit to start from the beginning."),
          limit: z.number().optional().describe("How many lines to read. Omit for the whole file."),
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
          const content = await agent.readTextFile({
            sessionId,
            path: input.abs_path,
            limit: input.limit,
            line: input.offset,
          });

          return {
            content: [
              {
                type: "text",
                text: content.content + SYSTEM_REMINDER,
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
  }

  if (clientCapabilities?.fs?.writeTextFile) {
    server.registerTool(
      unqualifiedToolNames.write,
      {
        title: "Write",
        description: `Writes content to the specified file in the project.

In sessions with ${toolNames.write} always use it instead of Write as it will
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
          await agent.writeTextFile({
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
      unqualifiedToolNames.edit,
      {
        title: "Edit",
        description: `Edit a file.

In sessions with ${toolNames.edit} always use it instead of Edit as it will
allow the user to conveniently review changes.

File editing instructions:
- The \`old_string\` param must match existing file content, including indentation.
- The \`old_string\` param must come from the actual file, not an outline.
- The \`old_string\` section must not be empty.
- Be minimal with replacements:
  - For unique lines, include only those lines.
  - For non-unique lines, include enough context to identify them.
- Do not escape quotes, newlines, or other characters.
- Only edit the specified file.
- If the \`old_string\` value isn't found in the file, the edit won't be applied. The tool will fail and must be retried.`,
        inputSchema: {
          abs_path: z.string().describe("The absolute path to the file to read."),
          old_string: z.string().describe("The old text to replace (must be unique in the file)"),
          new_string: z.string().describe("The new text."),
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

        const { content } = await agent.readTextFile({
          sessionId,
          path: input.abs_path,
        });

        const { newContent } = replaceAndCalculateLocation(content, [
          {
            oldText: input.old_string,
            newText: input.new_string,
            replaceAll: false,
          },
        ]);

        const patch = diff.createPatch(input.abs_path, content, newContent);

        await agent.writeTextFile({
          sessionId,
          path: input.abs_path,
          content: newContent,
        });

        return {
          content: [
            {
              type: "text",
              text: patch,
            },
          ],
        };
      },
    );

    server.registerTool(
      unqualifiedToolNames.multiEdit,
      {
        title: "Multi Edit",
        description: `Edit a file with multiple sequential edits.

In sessions with ${toolNames.multiEdit} always use it instead of MultiEdit as it will
allow the user to conveniently review changes.

File editing instructions:
- The \`old_string\` param must match existing file content, including indentation.
- The \`old_string\` param must come from the actual file, not an outline.
- The \`old_string\` section must not be empty.
- Be minimal with replacements:
  - For unique lines, include only those lines.
  - For non-unique lines, include enough context to identify them, unless you're using \`replace_all\`
- Do not escape quotes, newlines, or other characters.
- If any of the provided \`old_string\` values aren't found in the file, no edits will be applied. The tool will fail and must be retried.`,
        inputSchema: {
          file_path: z.string().describe("The absolute path to the file to modify"),
          edits: z
            .array(
              z.object({
                old_string: z.string().describe("The text to replace"),
                new_string: z.string().describe("The text to replace it with"),
                replace_all: z
                  .boolean()
                  .optional()
                  .describe("Replace all occurrences of old_string (default false)"),
              }),
            )
            .min(1)
            .describe("Array of edit operations to perform sequentially on the file"),
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

        const { content } = await agent.readTextFile({
          sessionId,
          path: input.file_path,
        });

        const { newContent } = replaceAndCalculateLocation(
          content,
          input.edits.map((edit) => ({
            oldText: edit.old_string,
            newText: edit.new_string,
            replaceAll: edit.replace_all ?? false,
          })),
        );

        const patch = diff.createPatch(input.file_path, content, newContent);

        await agent.writeTextFile({
          sessionId,
          path: input.file_path,
          content: newContent,
        });

        return {
          content: [
            {
              type: "text",
              text: patch,
            },
          ],
        };
      },
    );
  }

  if (agent.clientCapabilities?.terminal) {
    server.registerTool(
      unqualifiedToolNames.bash,
      {
        title: "Bash",
        description: "Executes a bash command",
        inputSchema: {
          command: z.string().describe("The bash command to execute as a one-liner"),
          timeout_ms: z
            .number()
            .default(2 * 60 * 1000)
            .describe("Optional timeout in milliseconds"),
          run_in_background: z
            .boolean()
            .default(false)
            .describe(
              `When set to true, the command is started in the background. The tool returns an \`id\` that can be used with the \`${toolNames.bashOutput}\` tool to retrieve the current output, or the \`${toolNames.killBash}\` tool to stop it early.`,
            ),
        },
      },
      async (input, extra) => {
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

        const toolCallId = extra._meta?.["claudecode/toolUseId"];

        if (typeof toolCallId !== "string") {
          throw new Error("No tool call ID found");
        }

        if (!agent.clientCapabilities?.terminal || !agent.client.createTerminal) {
          throw new Error("unreachable");
        }

        const handle = await agent.client.createTerminal({
          command: input.command,
          sessionId,
          outputByteLimit: 32_000,
        });

        await agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            content: [{ type: "terminal", terminalId: handle.id }],
          },
        });

        const abortPromise = new Promise((resolve) => {
          if (extra.signal.aborted) {
            resolve(null);
          } else {
            extra.signal.addEventListener("abort", () => {
              resolve(null);
            });
          }
        });

        const statusPromise = Promise.race([
          handle.waitForExit().then((exitStatus) => ({ status: "exited" as const, exitStatus })),
          abortPromise.then(() => ({ status: "aborted" as const, exitStatus: null })),
          sleep(input.timeout_ms).then(async () => {
            if (agent.backgroundTerminals[handle.id]?.status === "started") {
              await handle.kill();
            }
            return { status: "timedOut" as const, exitStatus: null };
          }),
        ]);

        if (input.run_in_background) {
          agent.backgroundTerminals[handle.id] = {
            handle,
            lastOutput: null,
            status: "started",
          };

          statusPromise.then(async ({ status, exitStatus }) => {
            const bgTerm = agent.backgroundTerminals[handle.id];

            if (bgTerm.status !== "started") {
              return;
            }

            const currentOutput = await handle.currentOutput();

            agent.backgroundTerminals[handle.id] = {
              status,
              pendingOutput: {
                ...currentOutput,
                output: stripCommonPrefix(bgTerm.lastOutput?.output ?? "", currentOutput.output),
                exitStatus: exitStatus ?? currentOutput.exitStatus,
              },
            };

            return handle.release();
          });

          return {
            content: [
              {
                type: "text",
                text: `Command started in background with id: ${handle.id}`,
              },
            ],
          };
        }

        await using terminal = handle;

        const { status } = await statusPromise;

        if (status === "aborted") {
          return {
            content: [{ type: "text", text: "Tool cancelled by user" }],
          };
        }

        const output = await terminal.currentOutput();

        return {
          content: [{ type: "text", text: toolCommandOutput(status, output) }],
        };
      },
    );

    server.registerTool(
      unqualifiedToolNames.bashOutput,
      {
        title: "BashOutput",
        description:
          "Returns the current output and exit status of a background bash command by its id. Includes only new output since last invocation.",
        inputSchema: {
          id: z
            .string()
            .describe(`The id of the background bash command as returned by \`${toolNames.bash}\``),
        },
      },
      async (input) => {
        const bgTerm = agent.backgroundTerminals[input.id];

        if (!bgTerm) {
          throw new Error(`Unknown shell ${input.id}`);
        }

        if (bgTerm.status === "started") {
          const newOutput = await bgTerm.handle.currentOutput();
          const strippedOutput = stripCommonPrefix(
            bgTerm.lastOutput?.output ?? "",
            newOutput.output,
          );
          bgTerm.lastOutput = newOutput;

          return {
            content: [
              {
                type: "text",
                text: toolCommandOutput(bgTerm.status, {
                  ...newOutput,
                  output: strippedOutput,
                }),
              },
            ],
          };
        } else {
          return {
            content: [
              {
                type: "text",
                text: toolCommandOutput(bgTerm.status, bgTerm.pendingOutput),
              },
            ],
          };
        }
      },
    );

    server.registerTool(
      unqualifiedToolNames.killBash,
      {
        title: "KillBash",
        description: "Stops a background command by its id",
        inputSchema: {
          id: z
            .string()
            .describe(`The id of the background bash command as returned by \`${toolNames.bash}\``),
        },
      },
      async (input) => {
        const bgTerm = agent.backgroundTerminals[input.id];

        if (!bgTerm) {
          throw new Error(`Unknown shell ${input.id}`);
        }

        switch (bgTerm.status) {
          case "started": {
            await bgTerm.handle.kill();
            const currentOutput = await bgTerm.handle.currentOutput();
            agent.backgroundTerminals[bgTerm.handle.id] = {
              status: "killed",
              pendingOutput: {
                ...currentOutput,
                output: stripCommonPrefix(bgTerm.lastOutput?.output ?? "", currentOutput.output),
              },
            };
            await bgTerm.handle.release();

            return {
              content: [{ type: "text", text: "Command killed successfully." }],
            };
          }
          case "aborted":
            return {
              content: [{ type: "text", text: "Command aborted by user." }],
            };
          case "exited":
            return {
              content: [{ type: "text", text: "Command had already exited." }],
            };
          case "killed":
            return {
              content: [{ type: "text", text: "Command was already killed." }],
            };
          case "timedOut":
            return {
              content: [{ type: "text", text: "Command killed by timeout." }],
            };
          default: {
            return unreachable(bgTerm);
          }
        }
      },
    );
  }

  const alwaysAllowedTools: { [key: string]: boolean } = {};
  server.registerTool(
    unqualifiedToolNames.permission,
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
      const result = await canUseTool(input);

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  async function canUseTool(input: {
    tool_use_id?: string;
    tool_name: string;
    input?: any;
  }): Promise<PermissionResult> {
    const session = agent.sessions[sessionId];
    if (!session) {
      return {
        behavior: "deny",
        message: "Session not found",
      };
    }

    if (input.tool_name === "ExitPlanMode") {
      const response = await agent.client.requestPermission({
        options: [
          {
            kind: "allow_always",
            name: "Yes, and auto-accept edits",
            optionId: "acceptEdits",
          },
          { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
          { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
        ],
        sessionId,
        toolCall: {
          toolCallId: input.tool_use_id!,
          rawInput: input.input,
        },
      });

      if (
        response.outcome?.outcome === "selected" &&
        (response.outcome.optionId === "default" || response.outcome.optionId === "acceptEdits")
      ) {
        session.permissionMode = response.outcome.optionId;
        await agent.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: response.outcome.optionId,
          },
        });

        return {
          behavior: "allow",
          updatedInput: input.input,
          updatedPermissions: [
            { type: "setMode", mode: response.outcome.optionId, destination: "session" },
          ],
        };
      } else {
        return {
          behavior: "deny",
          message: "User rejected request to exit plan mode.",
        };
      }
    }

    if (
      session.permissionMode === "bypassPermissions" ||
      (session.permissionMode === "acceptEdits" && editToolNames.includes(input.tool_name)) ||
      alwaysAllowedTools[input.tool_name]
    ) {
      return {
        behavior: "allow",
        updatedInput: input.input,
      };
    }

    const response = await agent.client.requestPermission({
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
      response.outcome?.outcome === "selected" &&
      (response.outcome.optionId === "allow" || response.outcome.optionId === "allow_always")
    ) {
      if (response.outcome.optionId === "allow_always") {
        alwaysAllowedTools[input.tool_name] = true;
      }
      return {
        behavior: "allow",
        updatedInput: input.input,
      };
    } else {
      return {
        behavior: "deny",
        message: "User refused permission to run tool",
      };
    }
  }

  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    try {
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
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
            message: `Internal server error: ${error}`,
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

function stripCommonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return b.slice(i);
}

function toolCommandOutput(
  status: "started" | "aborted" | "exited" | "killed" | "timedOut",
  output: TerminalOutputResponse,
): string {
  const { exitStatus, output: commandOutput, truncated } = output;

  let toolOutput = "";

  switch (status) {
    case "started":
    case "exited": {
      if (exitStatus && (exitStatus.exitCode ?? null) === null) {
        toolOutput += `Interrupted by the user. `;
      }
      break;
    }
    case "killed":
      toolOutput += `Killed. `;
      break;
    case "timedOut":
      toolOutput += `Timed out. `;
      break;
    case "aborted":
      break;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }

  if (exitStatus) {
    if (typeof exitStatus.exitCode === "number") {
      toolOutput += `Exited with code ${exitStatus.exitCode}.`;
    }

    if (typeof exitStatus.signal === "string") {
      toolOutput += `Signal \`${exitStatus.signal}\`. `;
    }

    toolOutput += "Final output:\n\n";
  } else {
    toolOutput += "New output:\n\n";
  }

  toolOutput += commandOutput;

  if (truncated) {
    toolOutput += `\n\nCommand output was too long, so it was truncated to ${commandOutput.length} bytes.`;
  }

  return toolOutput;
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
      throw new Error(`The provided \`old_string\` is empty.\n\nNo edits were applied.`);
    }

    if (edit.replaceAll) {
      // Replace all occurrences with marker + newText
      const parts: string[] = [];
      let lastIndex = 0;
      let searchIndex = 0;

      while (true) {
        const index = currentContent.indexOf(edit.oldText, searchIndex);
        if (index === -1) {
          if (searchIndex === 0) {
            throw new Error(
              `The provided \`old_string\` does not appear in the file: "${edit.oldText}".\n\nNo edits were applied.`,
            );
          }
          break;
        }

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
      if (index === -1) {
        throw new Error(
          `The provided \`old_string\` does not appear in the file: "${edit.oldText}".\n\nNo edits were applied.`,
        );
      } else {
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
