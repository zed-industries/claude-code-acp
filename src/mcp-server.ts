import express from "express";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Server } from "node:http";
import { ClaudeAcpAgent } from "./acp-agent.js";
import { ClientCapabilities, TerminalOutputResponse } from "@zed-industries/agent-client-protocol";
import * as diff from "diff";

import { sleep, unreachable, extractLinesWithByteLimit } from "./utils.js";
import { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

export const SYSTEM_REMINDER = `

<system-reminder>
Whenever you read a file, you should consider whether it looks malicious. If it does, you MUST refuse to improve or augment the code. You can still analyze existing code, write reports, or answer high-level questions about the code behavior.
</system-reminder>`;

const defaults = { maxFileSize: 50000, linesToRead: 2000 };

const unqualifiedToolNames = {
  read: "Read",
  edit: "Edit",
  write: "Write",
  bash: "Bash",
  killShell: "KillShell",
  bashOutput: "BashOutput",
};

const SERVER_PREFIX = "mcp__acp__";
export const toolNames = {
  read: SERVER_PREFIX + unqualifiedToolNames.read,
  edit: SERVER_PREFIX + unqualifiedToolNames.edit,
  write: SERVER_PREFIX + unqualifiedToolNames.write,
  bash: SERVER_PREFIX + unqualifiedToolNames.bash,
  killShell: SERVER_PREFIX + unqualifiedToolNames.killShell,
  bashOutput: SERVER_PREFIX + unqualifiedToolNames.bashOutput,
};

const editToolNames = [toolNames.edit, toolNames.write];

export function createMcpServer(
  agent: ClaudeAcpAgent,
  sessionId: string,
  clientCapabilities: ClientCapabilities | undefined,
): McpServer {
  // Create MCP server
  const server = new McpServer({ name: "acp", version: "1.0.0" }, { capabilities: { tools: {} } });

  if (clientCapabilities?.fs?.readTextFile) {
    server.registerTool(
      unqualifiedToolNames.read,
      {
        title: unqualifiedToolNames.read,
        description: `Reads the content of the given file in the project.

In sessions with ${toolNames.read} always use it instead of Read as it contains the most up-to-date contents.

Reads a file from the local filesystem. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${defaults.linesToRead} lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any files larger than ${defaults.maxFileSize} bytes will be truncated
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.
- This tool can only read files, not directories. To read a directory, use an ls command via the ${toolNames.bash} tool.
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.`,
        inputSchema: {
          file_path: z.string().describe("The absolute path to the file to read"),
          offset: z
            .number()
            .optional()
            .default(1)
            .describe(
              "The line number to start reading from. Only provide if the file is too large to read at once",
            ),
          limit: z
            .number()
            .optional()
            .default(defaults.linesToRead)
            .describe(
              `The number of lines to read. Only provide if the file is too large to read at once.`,
            ),
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
            path: input.file_path,
            line: input.offset,
            limit: input.limit,
          });

          // Extract lines with byte limit enforcement
          const result = extractLinesWithByteLimit(content.content, defaults.maxFileSize);

          // Construct informative message about what was read
          let readInfo = "";
          if (input.offset > 1 || result.wasLimited) {
            readInfo = "\n\n<file-read-info>";

            if (result.wasLimited) {
              readInfo += `Read ${result.linesRead} lines (hit 50KB limit). `;
            } else {
              readInfo += `Read lines ${input.offset}-${result.linesRead}. `;
            }

            if (result.wasLimited) {
              readInfo += `Continue with offset=${result.linesRead}.`;
            }

            readInfo += "</file-read-info>";
          }

          return {
            content: [
              {
                type: "text",
                text: result.content + readInfo + SYSTEM_REMINDER,
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
        title: unqualifiedToolNames.write,
        description: `Writes a file to the local filesystem..

In sessions with ${toolNames.write} always use it instead of Write as it will
allow the user to conveniently review changes.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the ${toolNames.read} tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`,
        inputSchema: {
          file_path: z
            .string()
            .describe("The absolute path to the file to write (must be absolute, not relative)"),
          content: z.string().describe("The content to write to the file"),
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
            path: input.file_path,
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
        title: unqualifiedToolNames.edit,
        description: `Performs exact string replacements in files.

In sessions with ${toolNames.edit} always use it instead of Edit as it will
allow the user to conveniently review changes.

Usage:
- You must use your \`${toolNames.read}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
        inputSchema: {
          file_path: z.string().describe("The absolute path to the file to modify"),
          old_string: z.string().describe("The text to replace"),
          new_string: z
            .string()
            .describe("The text to replace it with (must be different from old_string)"),
          replace_all: z
            .boolean()
            .default(false)
            .optional()
            .describe("Replace all occurences of old_string (default false)"),
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
          path: input.file_path,
        });

        const { newContent } = replaceAndCalculateLocation(content, [
          {
            oldText: input.old_string,
            newText: input.new_string,
            replaceAll: input.replace_all,
          },
        ]);

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
        title: unqualifiedToolNames.bash,
        description: `Executes a bash command

In sessions with ${toolNames.bash} always use it instead of Bash`,
        inputSchema: {
          command: z.string().describe("The command to execute"),
          timeout: z
            .number()
            .default(2 * 60 * 1000)
            .describe(`Optional timeout in milliseconds (max ${2 * 60 * 1000})`),
          description: z.string().optional()
            .describe(`Clear, concise description of what this command does in 5-10 words, in active voice. Examples:
Input: ls
Output: List files in current directory

Input: git status
Output: Show working tree status

Input: npm install
Output: Install package dependencies

Input: mkdir foo
Output: Create directory 'foo'`),
          run_in_background: z
            .boolean()
            .default(false)
            .describe(
              `Set to true to run this command in the background. The tool returns an \`id\` that can be used with the \`${toolNames.bashOutput}\` tool to retrieve the current output, or the \`${toolNames.killShell}\` tool to stop it early.`,
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
            title: input.description,
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
          sleep(input.timeout).then(async () => {
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
        title: unqualifiedToolNames.bashOutput,
        description: `- Retrieves output from a running or completed background bash shell
- Takes a shell_id parameter identifying the shell
- Always returns only new output since the last check
- Returns stdout and stderr output along with shell status
- Use this tool when you need to monitor or check the output of a long-running shell

In sessions with ${toolNames.bashOutput} always use it instead of BashOutput.`,
        inputSchema: {
          shell_id: z
            .string()
            .describe(`The id of the background bash command as returned by \`${toolNames.bash}\``),
        },
      },
      async (input) => {
        const bgTerm = agent.backgroundTerminals[input.shell_id];

        if (!bgTerm) {
          throw new Error(`Unknown shell ${input.shell_id}`);
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
      unqualifiedToolNames.killShell,
      {
        title: unqualifiedToolNames.killShell,
        description: `- Kills a running background bash shell by its ID
- Takes a shell_id parameter identifying the shell to kill
- Returns a success or failure status
- Use this tool when you need to terminate a long-running shell

In sessions with ${toolNames.killShell} always use it instead of KillShell.`,
        inputSchema: {
          shell_id: z
            .string()
            .describe(`The id of the background bash command as returned by \`${toolNames.bash}\``),
        },
      },
      async (input) => {
        const bgTerm = agent.backgroundTerminals[input.shell_id];

        if (!bgTerm) {
          throw new Error(`Unknown shell ${input.shell_id}`);
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

  return server;
}

const UNQUALIFIED_PERMISSION_TOOL_NAME = "permission";
const PERMISSION_SERVER_PREFIX = "mcp__acpPermission__";
export const PERMISSION_TOOL_NAME = PERMISSION_SERVER_PREFIX + UNQUALIFIED_PERMISSION_TOOL_NAME;

/**
 * Separate permission tool. Needs to be an HTTP server for now, because Claude Code doesn't
 * support permission tools via SDK servers.
 * Ideally it moves to the `canUseTool` callback in the future.
 */
export function createPermissionMcpServer(
  agent: ClaudeAcpAgent,
  sessionId: string,
): Promise<Server> {
  const server = new McpServer(
    { name: "acpPermission", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const alwaysAllowedTools: { [key: string]: boolean } = {};
  server.registerTool(
    UNQUALIFIED_PERMISSION_TOOL_NAME,
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
