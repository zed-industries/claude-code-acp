import {
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@zed-industries/agent-client-protocol";
import { replaceAndCalculateLocation, SYSTEM_REMINDER, toolNames } from "./mcp-server.js";
import { ToolResultBlockParam } from "@anthropic-ai/sdk/resources";

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

export function toolInfoFromToolUse(
  toolUse: any,
  cachedFileContent: { [key: string]: string },
): ToolInfo {
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
        title: input?.notebook_path ? `Read Notebook ${input.notebook_path}` : "Read Notebook",
        kind: "read",
        content: [],
        locations: input?.notebook_path ? [{ path: input.notebook_path }] : [],
      };

    case "NotebookEdit":
      return {
        title: input?.notebook_path ? `Edit Notebook ${input.notebook_path}` : "Edit Notebook",
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
    case toolNames.bash:
      return {
        title: input?.command ? "`" + input.command.replaceAll("`", "\\`") + "`" : "Terminal",
        kind: "execute",
        content:
          input && input.description
            ? [
                {
                  type: "content",
                  content: { type: "text", text: input.description },
                },
              ]
            : [],
      };

    case "BashOutput":
    case toolNames.bashOutput:
      return {
        title: "Tail Logs",
        kind: "execute",
        content: [],
      };

    case "KillShell":
    case toolNames.killShell:
      return {
        title: "Kill Process",
        kind: "execute",
        content: [],
      };

    case toolNames.read: {
      let limit = "";
      if (input.limit) {
        limit =
          " (" + ((input.offset ?? 0) + 1) + " - " + ((input.offset ?? 0) + input.limit) + ")";
      } else if (input.offset) {
        limit = " (from line " + (input.offset + 1) + ")";
      }
      return {
        title: "Read " + (input.file_path ?? "File") + limit,
        kind: "read",
        locations: [
          {
            path: input.file_path,
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
        content: [],
        locations: [{ path: input.file_path, line: input.offset ?? 0 }],
      };

    case "LS":
      return {
        title: `List the ${input?.path ? "`" + input.path + "`" : "current"} directory's contents`,
        kind: "search",
        content: [],
        locations: [],
      };

    case toolNames.edit:
    case "Edit": {
      const path = input?.file_path ?? input?.file_path;
      let oldText = input.old_string ?? null;
      let newText = input.new_string ?? "";
      let affectedLines: number[] = [];

      if (path && oldText) {
        try {
          const oldContent = cachedFileContent[path] || "";
          const newContent = replaceAndCalculateLocation(oldContent, [
            {
              oldText,
              newText,
              replaceAll: false,
            },
          ]);
          oldText = oldContent;
          newText = newContent.newContent;
          affectedLines = newContent.lineNumbers;
        } catch (e) {
          console.error(e);
        }
      }
      return {
        title: path ? `Edit \`${path}\`` : "Edit",
        kind: "edit",
        content:
          input && path
            ? [
                {
                  type: "diff",
                  path,
                  oldText,
                  newText,
                },
              ]
            : [],
        locations: path
          ? affectedLines.length > 0
            ? affectedLines.map((line) => ({ line, path }))
            : [{ path }]
          : [],
      };
    }

    case toolNames.write: {
      let content: ToolCallContent[] = [];
      if (input && input.file_path) {
        content = [
          {
            type: "diff",
            path: input.file_path,
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
        title: input?.file_path ? `Write ${input.file_path}` : "Write",
        kind: "edit",
        content,
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };
    }

    case "Write":
      return {
        title: input?.file_path ? `Write ${input.file_path}` : "Write",
        kind: "edit",
        content:
          input && input.file_path
            ? [
                {
                  type: "diff",
                  path: input.file_path,
                  oldText: null,
                  newText: input.content,
                },
              ]
            : [],
        locations: input?.file_path ? [{ path: input.file_path }] : [],
      };

    case "Glob": {
      let label = "Find";
      if (input.path) {
        label += ` \`${input.path}\``;
      }
      if (input.pattern) {
        label += ` \`${input.pattern}\``;
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
          default:
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

    case "ExitPlanMode":
      return {
        title: "Ready to code?",
        kind: "switch_mode",
        content:
          input && input.plan
            ? [{ type: "content", content: { type: "text", text: input.plan } }]
            : [],
      };

    case "Other": {
      let output;
      try {
        output = JSON.stringify(input, null, 2);
      } catch {
        output = typeof input === "string" ? input : "{}";
      }
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: `\`\`\`json\n${output}\`\`\``,
            },
          },
        ],
      };
    }

    default:
      return {
        title: name || "Unknown Tool",
        kind: "other",
        content: [],
      };
  }
}

export function toolUpdateFromToolResult(
  toolResult: ToolResultBlockParam,
  toolUse: any | undefined,
): ToolUpdate {
  switch (toolUse?.name) {
    case "Read":
    case toolNames.read:
      if (Array.isArray(toolResult.content) && toolResult.content.length > 0) {
        return {
          content: toolResult.content.map((content: any) => ({
            type: "content",
            content:
              content.type === "text"
                ? {
                    type: "text",
                    text: markdownEscape(content.text.replace(SYSTEM_REMINDER, "")),
                  }
                : content,
          })),
        };
      } else if (typeof toolResult.content === "string" && toolResult.content.length > 0) {
        return {
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: markdownEscape(toolResult.content.replace(SYSTEM_REMINDER, "")),
              },
            },
          ],
        };
      }
      return {};

    case toolNames.bash:
    case "edit":
    case "Edit":
    case toolNames.edit:
    case toolNames.write:
    case "Write": {
      if (toolResult.is_error && toolResult.content && toolResult.content.length > 0) {
        // Only return errors
        return toAcpContentUpdate(toolResult.content, true);
      }
      return {};
    }

    case "ExitPlanMode": {
      return { title: "Exited Plan Mode" };
    }

    case "Task":
    case "NotebookEdit":
    case "NotebookRead":
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
    default: {
      return toAcpContentUpdate(toolResult.content, toolResult.is_error);
    }
  }
}

function toAcpContentUpdate(
  content: any,
  isError: boolean = false,
): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((content: any) => ({
        type: "content",
        content:
          isError && content.type === "text"
            ? {
                ...content,
                text: `\`\`\`\n${content.text}\n\`\`\``,
              }
            : content,
      })),
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

export type ClaudePlanEntry = {
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

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}
