import {
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
    case "Terminal":
    case "Bash":
      return input?.command ?? "Terminal";
    case "ReadFile":
      return "Read File";
    case "LS":
      return input?.path ? `List Directory ${input.path}` : "List Directory";
    case "Edit":
      return input?.abs_path ? `Edit ${input.abs_path}` : "Edit";
    case "MultiEdit":
      return input?.file_path ? `Multi Edit ${input.file_path}` : "Multi Edit";
    case "Write":
      return input?.abs_path ? `Write ${input.abs_path}` : "Write";
    case "Glob":
      return input ? `Glob \`${input}\`` : "Glob";
    case "Grep":
      return input ? `\`${input}\`` : "Grep";
    case "WebFetch":
      return input?.url ? `Fetch ${input.url}` : "Fetch";
    case "WebSearch":
      return input ? `Web Search: ${input}` : "Web Search";
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
    case "Edit":
      return "edit";
    case "MultiEdit":
      return "edit";
    case "Write":
      return "edit";
    case "ReadFile":
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
    case "ReadFile":
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
      if (input) {
        return [
          {
            type: "content",
            content: { type: "text", text: input.toString() },
          },
        ];
      }
      break;
    case "Grep":
      if (input) {
        return [
          { type: "content", content: { type: "text", text: `\`${input}\`` } },
        ];
      }
      break;
    case "WebFetch":
      if (input && input.prompt) {
        return [
          { type: "content", content: { type: "text", text: input.prompt } },
        ];
      }
      break;
    case "WebSearch":
      if (input) {
        return [
          {
            type: "content",
            content: { type: "text", text: input.toString() },
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
