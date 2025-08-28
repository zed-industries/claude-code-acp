import { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import {
  PlanEntry,
  ToolCallContent,
  ToolKind,
} from "@zed-industries/agent-client-protocol";

interface ToolInfo {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
}

export function extractToolInfo(toolUse: any): ToolInfo {
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
      };

    case "LS":
      return {
        title: input?.path ? input.path : "Current Directory",
        kind: "search",
        content: [],
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
      };

    case "MultiEdit":
      return {
        title: input?.file_path
          ? `Multi Edit ${input.file_path}`
          : "Multi Edit",
        kind: "edit",
        content:
          input && input.edits && input.edits.length > 0
            ? [
                {
                  type: "diff",
                  path: input.file_path,
                  oldText: input.edits[0].old_string || null,
                  newText: input.edits[0].new_string,
                },
              ]
            : [],
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
      };
    }

    case "Grep": {
      let label = "grep";

      if (input.case_insensitive) {
        label += " -i";
      }
      if (input.line_numbers) {
        label += " -n";
      }

      if (input.after_context !== undefined) {
        label += ` -A ${input.after_context}`;
      }
      if (input.before_context !== undefined) {
        label += ` -B ${input.before_context}`;
      }
      if (input.context !== undefined) {
        label += ` -C ${input.context}`;
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

      if (input.file_type) {
        label += ` --type=${input.file_type}`;
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
        kind: "search",
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
