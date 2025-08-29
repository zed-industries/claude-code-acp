import { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import {
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@zed-industries/agent-client-protocol";

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolUpdate {
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

export function toolInfoFromToolUse(toolUse: any): ToolInfo {
  const name = toolUse.name;
  const input = toolUse.input;

  switch (name) {
    case "Task":
      return {
        title: input?.description ? input.description : "Task",
        kind: "think",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };

    case "NotebookRead":
      return {
        title: input?.notebook_path
          ? `Read Notebook ${input.notebook_path}`
          : "Read Notebook",
        kind: "read",
        content:
          input && input.notebook_path
            ? [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: input.notebook_path.toString(),
                  },
                },
              ]
            : [],
        locations: input?.notebook_path ? [{ path: input.notebook_path }] : [],
      };

    case "NotebookEdit":
      return {
        title: input?.notebook_path
          ? `Edit Notebook ${input.notebook_path}`
          : "Edit Notebook",
        kind: "edit",
        content:
          input && input.new_source
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.new_source },
                },
              ]
            : [],
        locations: input?.notebook_path ? [{ path: input.notebook_path }] : [],
      };

    case "Bash":
      return {
        title: input?.command
          ? "`" + input.command.replaceAll("`", "\\`") + "`"
          : "Terminal",
        kind: "execute",
        content:
          input && input.command
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.description },
                },
              ]
            : [],
      };

    case "BashOutput":
      return {
        title: "Tail Logs",
        kind: "execute",
        content: [],
      };

    case "KillBash":
      return {
        title: "Kill Process",
        kind: "execute",
        content: [],
      };

    case "mcp__acp__read": {
      let limit = "";
      if (input.limit) {
        limit =
          " (" +
          ((input.offset ?? 0) + 1) +
          " - " +
          ((input.offset ?? 0) + input.limit) +
          ")";
      } else if (input.offset) {
        limit = " (from line " + (input.offset + 1) + ")";
      }
      return {
        title: "Read " + (input.abs_path ?? "File") + limit,
        kind: "read",
        locations: [
          {
            path: input.abs_path,
            line: input.offset ?? 0,
          },
        ],
        content: [],
      };
    }

    case "Read":
      return {
        title: "Read File",
        kind: "read",
        content:
          input && input.abs_path
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.abs_path.toString() },
                },
              ]
            : [],
        locations: [{ path: input.abs_path, line: input.offset ?? 0 }],
      };

    case "LS":
      return {
        title: input?.path ? input.path : "Current Directory",
        kind: "search",
        content: [],
        locations: input?.path ? [{ path: input.path }] : [],
      };

    case "mcp__acp__edit":
    case "Edit":
      return {
        title: input?.abs_path ? `Edit ${input.abs_path}` : "Edit",
        kind: "edit",
        content:
          input && input.abs_path
            ? [
                {
                  type: "diff",
                  path: input.abs_path,
                  oldText: input.old_text || null,
                  newText: input.new_text,
                },
              ]
            : [],
        locations: input?.abs_path ? [{ path: input.abs_path }] : [],
      };

    case "mcp__acp__multi-edit":
    case "MultiEdit":
      // Display it as a normal edit, because end users don't care about
      // the distinction between edits and multi-edits.
      return {
        title: input?.file_path ? `Edit ${input.file_path}` : "Edit",
        kind: "edit",
        content:
          input && input.edits && input.edits.length > 0
            ? input.edits.map((edit: any) => ({
                type: "diff" as const,
                path: input.file_path,
                oldText: edit.old_string || null,
                newText: edit.new_string,
              }))
            : [],
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };

    case "mcp__acp__write":
      let content: ToolCallContent[] = [];
      if (input && input.abs_path) {
        content = [
          {
            type: "diff",
            path: input.abs_path,
            oldText: null,
            newText: input.content,
          },
        ];
      } else if (input && input.content) {
        content = [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      return {
        title: input?.abs_path ? `Write ${input.abs_path}` : "Write",
        kind: "edit",
        content,
        locations: input?.abs_path ? [{ path: input.abs_path }] : [],
      };

    case "Write":
      return {
        title: input?.abs_path ? `Write ${input.abs_path}` : "Write",
        kind: "edit",
        content:
          input && input.abs_path
            ? [
                {
                  type: "diff",
                  path: input.abs_path,
                  oldText: null,
                  newText: input.content,
                },
              ]
            : [],
        locations: input?.abs_path ? [{ path: input.abs_path }] : [],
      };

    case "Glob": {
      let label = "Find";
      if (input.path) {
        label += ` ${input.path}`;
      }
      if (input.pattern) {
        label += ` ${input.pattern}`;
      }
      return {
        title: label,
        kind: "search",
        content: [],
        locations: input.path ? [{ path: input.path }] : [],
      };
    }

    case "Grep": {
      let label = "grep";

      if (input["-i"]) {
        label += " -i";
      }
      if (input["-n"]) {
        label += " -n";
      }

      if (input["-A"] !== undefined) {
        label += ` -A ${input["-A"]}`;
      }
      if (input["-B"] !== undefined) {
        label += ` -B ${input["-B"]}`;
      }
      if (input["-C"] !== undefined) {
        label += ` -C ${input["-C"]}`;
      }

      if (input.output_mode) {
        switch (input.output_mode) {
          case "FilesWithMatches":
            label += " -l";
            break;
          case "Count":
            label += " -c";
            break;
          case "Content":
            break;
        }
      }

      if (input.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }

      if (input.glob) {
        label += ` --include="${input.glob}"`;
      }

      if (input.type) {
        label += ` --type=${input.type}`;
      }

      if (input.multiline) {
        label += " -P";
      }

      label += ` "${input.pattern}"`;

      if (input.path) {
        label += ` ${input.path}`;
      }

      return {
        title: label,
        kind: "search",
        content: [],
      };
    }

    case "WebFetch":
      return {
        title: input?.url ? `Fetch ${input.url}` : "Fetch",
        kind: "fetch",
        content:
          input && input.prompt
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.prompt },
                },
              ]
            : [],
      };

    case "WebSearch": {
      let label = `"${input.query}"`;

      if (input.allowed_domains && input.allowed_domains.length > 0) {
        label += ` (allowed: ${input.allowed_domains.join(", ")})`;
      }

      if (input.blocked_domains && input.blocked_domains.length > 0) {
        label += ` (blocked: ${input.blocked_domains.join(", ")})`;
      }

      return {
        title: label,
        kind: "fetch",
        content: [],
      };
    }

    case "TodoWrite":
      return {
        title: input?.todos
          ? `Update TODOs: ${input.todos.map((todo: any) => todo.content).join(", ")}`
          : "Update TODOs",
        kind: "think",
        content: [],
      };

    case "exit_plan_mode":
      return {
        title: "Exit Plan Mode",
        kind: "think",
        content:
          input && input.plan
            ? [{ type: "content", content: { type: "text", text: input.plan } }]
            : [],
      };

    case "Other":
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`json\n${JSON.stringify(input, null, 2) || "{}"}\`\`\``,
            },
          },
        ],
      };

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

export function toolUpdateFromToolResult(
  toolResult: any,
  toolUse: any | undefined,
): ToolUpdate {
  switch (toolUse?.name) {
    case "mcp__acp__edit":
    case "edit":
    case "Edit": {
      // Parse the line numbers from the tool result
      if (toolResult.content && toolResult.content.length > 0) {
        try {
          const firstContent = toolResult.content[0];
          const data = JSON.parse(firstContent.text || firstContent);
          if (data.lineNumbers && Array.isArray(data.lineNumbers)) {
            const locations: ToolCallLocation[] = data.lineNumbers.map(
              (line: number) => ({
                path: toolUse?.input?.abs_path || toolUse?.input?.file_path,
                line: line,
              }),
            );
            return { locations };
          }
        } catch (e) {
          // If parsing fails, return empty object
          return {};
        }
      }
      return {};
    }
    case "mcp__acp__multi-edit":
    case "multi-edit":
    case "MultiEdit": {
      // Parse the line numbers from the tool result
      if (toolResult.content && toolResult.content.length > 0) {
        try {
          const firstContent = toolResult.content[0];
          const data = JSON.parse(firstContent.text || firstContent);
          if (data.lineNumbers && Array.isArray(data.lineNumbers)) {
            const locations: ToolCallLocation[] = data.lineNumbers.map(
              (line: number) => ({
                path: toolUse?.input?.file_path || toolUse?.input?.abs_path,
                line: line,
              }),
            );
            return { locations };
          }
        } catch (e) {
          // If parsing fails, return empty object
          return {};
        }
      }
      return {};
    }
    case "Task":
    case "NotebookEdit":
    case "NotebookRead":
    case "mcp__acp__write":
    case "Write":
    case "TodoWrite":
    case "exit_plan_mode":
    case "Bash":
    case "BashOutput":
    case "KillBash":
    case "LS":
    case "Glob":
    case "Grep":
    case "WebFetch":
    case "WebSearch":
    case "Other":
    case "mcp__acp__read":
      if (Array.isArray(toolResult.content)) {
        return {
          content: toolResult.content.map((content: any) => ({
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`${toolUse.input?.abs_path ?? ""}\n${content.text ?? ""}\n\`\`\``,
            },
          })),
        };
      }
      return {};
    default: {
      if (Array.isArray(toolResult.content)) {
        return {
          content: toolResult.content.map((content: any) => ({
            type: "content",
            content,
          })),
        };
      } else if (typeof toolResult.content === "string") {
        return {
          content: [
            {
              type: "content",
              content: { type: "text", text: toolResult.content },
            },
          ],
        };
      }
      return {};
    }
  }
}

type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] }): PlanEntry[] {
  return input.todos.map((input) => ({
    content: input.content,
    status: input.status,
    priority: "medium",
  }));
}
