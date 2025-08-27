import {
  PlanEntry,
  ToolCallContent,
  ToolKind,
} from "@zed-industries/agent-client-protocol";

export function toolLabel(toolUse: any): string {
  const name = toolUse.name;
  const input = toolUse.input;

  switch (name) {
    case "Task":
      return input?.description ? input.description : "Task";
    case "NotebookRead":
      return input?.notebook_path
        ? `Read Notebook ${input.notebook_path}`
        : "Read Notebook";
    case "NotebookEdit":
      return input?.notebook_path
        ? `Edit Notebook ${input.notebook_path}`
        : "Edit Notebook";
    case "Bash":
      return input?.command ?? "Terminal";
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
      return "Read " + (input.abs_path ?? "File") + limit;
    }
    case "Read":
      return "Read File";
    case "LS":
      return input?.path ? `List Directory ${input.path}` : "List Directory";
    case "mcp__acp__edit":
    case "Edit":
      return input?.abs_path ? `Edit ${input.abs_path}` : "Edit";
    case "MultiEdit":
      return input?.file_path ? `Multi Edit ${input.file_path}` : "Multi Edit";
    case "mcp__acp__write":
    case "Write":
      return input?.abs_path ? `Write ${input.abs_path}` : "Write";
    case "Glob": {
      let label = "Find";
      if (input.path) {
        label += ` ${input.path}`;
      }
      if (input.pattern) {
        label += ` ${input.pattern}`;
      }
      // todo!() show number of results when we hvae them
      return label;
    }
    case "Grep": {
      let label = "grep";

      // Boolean flags
      if (input.case_insensitive) {
        label += " -i";
      }
      if (input.line_numbers) {
        label += " -n";
      }

      // Context options
      if (input.after_context !== undefined) {
        label += ` -A ${input.after_context}`;
      }
      if (input.before_context !== undefined) {
        label += ` -B ${input.before_context}`;
      }
      if (input.context !== undefined) {
        label += ` -C ${input.context}`;
      }

      // Output mode
      if (input.output_mode) {
        switch (input.output_mode) {
          case "FilesWithMatches":
            label += " -l";
            break;
          case "Count":
            label += " -c";
            break;
          case "Content":
            break; // Default mode
        }
      }

      // Head limit
      if (input.head_limit !== undefined) {
        label += ` | head -${input.head_limit}`;
      }

      // Glob pattern
      if (input.glob) {
        label += ` --include="${input.glob}"`;
      }

      // File type
      if (input.file_type) {
        label += ` --type=${input.file_type}`;
      }

      // Multiline
      if (input.multiline) {
        label += " -P"; // Perl-compatible regex for multiline
      }

      // Pattern (escaped if contains special characters)
      label += ` "${input.pattern}"`;

      // Path
      if (input.path) {
        label += ` ${input.path}`;
      }

      return label;
    }
    case "WebFetch": {
      return input?.url ? `Fetch ${input.url}` : "Fetch";
    }
    case "WebSearch": {
      let label = `"${input.query}"`;

      if (input.allowed_domains && input.allowed_domains.length > 0) {
        label += ` (allowed: ${input.allowed_domains.join(", ")})`;
      }

      if (input.blocked_domains && input.blocked_domains.length > 0) {
        label += ` (blocked: ${input.blocked_domains.join(", ")})`;
      }

      return label;
    }
    case "TodoWrite":
      return input?.todos
        ? `Update TODOs: ${input.todos.map((todo: any) => todo.content).join(", ")}`
        : "Update TODOs";
    case "exit_plan_mode":
      return "Exit Plan Mode";
    default:
      return name || "Unknown Tool";
  }
}

export function toolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "Task":
      return "think";
    case "NotebookRead":
      return "read";
    case "NotebookEdit":
      return "edit";
    case "mcp__acp__edit":
    case "Edit":
      return "edit";
    case "MultiEdit":
      return "edit";
    case "mcp__acp__write":
    case "Write":
      return "edit";
    case "mcp__acp__read":
    case "Read":
      return "read";
    case "LS":
      return "search";
    case "Glob":
      return "search";
    case "Grep":
      return "search";
    case "Bash":
    case "Terminal":
      return "execute";
    case "WebSearch":
      return "search";
    case "WebFetch":
      return "fetch";
    case "TodoWrite":
      return "think";
    case "exit_plan_mode":
      return "think";
    default:
      return "other";
  }
}

export function toolContent(toolUse: any): ToolCallContent[] {
  const input = toolUse.input;
  const name = toolUse.name;

  switch (name) {
    case "Other":
      return [
        {
          type: "content",
          content: {
            type: "text",
            text: `\`\`\`json\n${JSON.stringify(input, null, 2) || "{}"}\`\`\``,
          },
        },
      ];
    case "Task":
      if (input && input.prompt) {
        return [
          { type: "content", content: { type: "text", text: input.prompt } },
        ];
      }
      break;
    case "NotebookRead":
      if (input && input.notebook_path) {
        return [
          {
            type: "content",
            content: { type: "text", text: input.notebook_path.toString() },
          },
        ];
      }
      break;
    case "NotebookEdit":
      if (input && input.new_source) {
        return [
          {
            type: "content",
            content: { type: "text", text: input.new_source },
          },
        ];
      }
      break;
    case "Bash":
      if (input && input.command) {
        return [
          {
            type: "content",
            content: {
              type: "text",
              text: input.description,
            },
          },
        ];
      }
      break;
    case "mcp__acp__read":
      if (toolUse.content) {
        return [
          {
            type: "content",
            content: { type: "text", text: toolUse.content },
          },
        ];
      }
      break;
    case "Read":
      if (input && input.abs_path) {
        return [
          {
            type: "content",
            content: { type: "text", text: input.abs_path.toString() },
          },
        ];
      }
      break;
    case "LS":
      if (input && input.path) {
        return [
          {
            type: "content",
            content: { type: "text", text: input.path.toString() },
          },
        ];
      }
      break;
    case "Glob":
      if (toolUse.content) {
        return [
          {
            type: "content",
            content: { type: "text", text: toolUse.content },
          },
        ];
      }
      break;
    case "Grep":
      if (toolUse.content) {
        return [
          {
            type: "content",
            content: { type: "text", text: toolUse.content },
          },
        ];
      }
      break;
    case "WebFetch":
      if (toolUse.content) {
        return [
          {
            type: "content",
            content: { type: "text", text: toolUse.content },
          },
        ];
      }
      break;
    case "WebSearch":
      if (toolUse.content) {
        return [
          {
            type: "content",
            content: { type: "text", text: toolUse.content },
          },
        ];
      }
      break;
    case "exit_plan_mode":
      if (input && input.plan) {
        return [
          { type: "content", content: { type: "text", text: input.plan } },
        ];
      }
      break;
    case "mcp__acp__edit":
    case "Edit":
      if (input && input.abs_path) {
        return [
          {
            type: "diff",
            path: input.abs_path,
            oldText: input.old_text || null,
            newText: input.new_text,
          },
        ];
      }
      break;
    case "mcp__acp__write":
      if (input && input.abs_path) {
        return [
          {
            type: "diff",
            path: input.abs_path,
            oldText: null,
            newText: input.content,
          },
        ];
      }
      if (input.content) {
        return [
          {
            type: "content",
            content: { type: "text", text: input.content },
          },
        ];
      }
      break;
    case "Write":
      if (input && input.abs_path) {
        return [
          {
            type: "diff",
            path: input.abs_path,
            oldText: null,
            newText: input.content,
          },
        ];
      }
      break;
    case "MultiEdit":
      if (input && input.edits && input.edits.length > 0) {
        // todo: show multiple edits in a multibuffer?
        const edit = input.edits[0];
        return [
          {
            type: "diff",
            path: input.file_path,
            oldText: edit.old_string || null,
            newText: edit.new_string,
          },
        ];
      }
      break;
    case "TodoWrite":
      // These are mapped to plan updates later
      return [];
  }

  return [];
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
