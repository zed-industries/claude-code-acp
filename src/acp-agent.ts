import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  SetSessionModeRequest,
  SetSessionModeResponse,
  TerminalHandle,
  TerminalOutputResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@zed-industries/agent-client-protocol";
import {
  McpServerConfig,
  Options,
  PermissionMode,
  Query,
  query,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v7 as uuidv7 } from "uuid";
import { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";
import { SessionNotification } from "@zed-industries/agent-client-protocol";
import {
  createMcpServer,
  createPermissionMcpServer,
  PERMISSION_TOOL_NAME,
  toolNames,
} from "./mcp-server.js";
import { AddressInfo } from "node:net";
import {
  toolInfoFromToolUse,
  planEntries,
  toolUpdateFromToolResult,
  ClaudePlanEntry,
} from "./tools.js";

type Session = {
  query: Query;
  input: Pushable<SDKUserMessage>;
  cancelled: boolean;
  permissionMode: PermissionMode;
};

type BackgroundTerminal =
  | {
      handle: TerminalHandle;
      status: "started";
      lastOutput: TerminalOutputResponse | null;
    }
  | {
      status: "aborted" | "exited" | "killed" | "timedOut";
      pendingOutput: TerminalOutputResponse;
    };

type ToolUseCache = {
  [key: string]: { type: "tool_use"; id: string; name: string; input: any };
};

// Implement the ACP Agent interface
export class ClaudeAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: AgentSideConnection;
  toolUseCache: ToolUseCache;
  fileContentCache: { [key: string]: string };
  backgroundTerminals: { [key: string]: BackgroundTerminal } = {};
  clientCapabilities?: ClientCapabilities;

  constructor(client: AgentSideConnection) {
    this.sessions = {};
    this.client = client;
    this.toolUseCache = {};
    this.fileContentCache = {};
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;
    return {
      protocolVersion: 1,
      // todo!()
      agentCapabilities: {
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
      },
      authMethods: [
        {
          description: "Run `claude /login` in the terminal",
          name: "Log in with Claude Code",
          id: "claude-login",
        },
      ],
    };
  }
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (
      fs.existsSync(path.resolve(os.homedir(), ".claude.json.backup")) &&
      !fs.existsSync(path.resolve(os.homedir(), ".claude.json"))
    ) {
      throw RequestError.authRequired();
    }

    const sessionId = uuidv7();
    const input = new Pushable<SDKUserMessage>();

    const mcpServers: Record<string, McpServerConfig> = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        if ("type" in server) {
          mcpServers[server.name] = {
            type: server.type,
            url: server.url,
            headers: server.headers
              ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
              : undefined,
          };
        } else {
          mcpServers[server.name] = {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: server.env
              ? Object.fromEntries(server.env.map((e) => [e.name, e.value]))
              : undefined,
          };
        }
      }
    }

    const server = createMcpServer(this, sessionId, this.clientCapabilities);
    mcpServers["acp"] = {
      type: "sdk",
      name: "acp",
      instance: server,
    };

    // Ideally replace with `canUseTool`
    const permissionServer = await createPermissionMcpServer(this, sessionId);
    const address = permissionServer.address() as AddressInfo;
    mcpServers["acpPermission"] = {
      type: "http",
      url: "http://127.0.0.1:" + address.port + "/mcp",
      headers: {
        "x-acp-proxy-session-id": sessionId,
      },
    };

    const options: Options = {
      cwd: params.cwd,
      mcpServers,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      permissionPromptToolName: PERMISSION_TOOL_NAME,
      stderr: (err) => console.error(err),
      // note: although not documented by the types, passing an absolute path
      // here works to find zed's managed node version.
      executable: process.execPath as any,
    };

    const allowedTools = [];
    const disallowedTools = [];
    if (this.clientCapabilities?.fs?.readTextFile) {
      allowedTools.push(toolNames.read);
      disallowedTools.push("Read");
    }
    if (this.clientCapabilities?.fs?.writeTextFile) {
      allowedTools.push(toolNames.write);
      disallowedTools.push("Write", "Edit");
    }
    if (this.clientCapabilities?.terminal) {
      allowedTools.push(toolNames.bashOutput, toolNames.killShell);
      disallowedTools.push("Bash", "BashOutput", "KillShell");
    }

    if (allowedTools.length > 0) {
      options.allowedTools = allowedTools;
    }
    if (disallowedTools.length > 0) {
      options.disallowedTools = disallowedTools;
    }

    const q = query({
      prompt: input,
      options,
    });
    this.sessions[sessionId] = {
      query: q,
      input: input,
      cancelled: false,
      permissionMode: "default",
    };

    getAvailableSlashCommands(q).then((availableCommands) => {
      this.client.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands,
        },
      });
    });

    return {
      sessionId,
      modes: {
        currentModeId: "default",
        availableModes: [
          {
            id: "default",
            name: "Always Ask",
            description: "Prompts for permission on first use of each tool",
          },
          {
            id: "acceptEdits",
            name: "Accept Edits",
            description: "Automatically accepts file edit permissions for the session",
          },
          {
            id: "bypassPermissions",
            name: "Bypass Permissions",
            description: "Skips all permission prompts",
          },
          {
            id: "plan",
            name: "Plan Mode",
            description: "Claude can analyze but not modify files or execute commands",
          },
        ],
      },
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    throw new Error("Method not implemented.");
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    this.sessions[params.sessionId].cancelled = false;

    const { query, input } = this.sessions[params.sessionId];

    input.push(promptToClaude(params));
    while (true) {
      const { value: message, done } = await query.next();
      if (done || !message) {
        if (this.sessions[params.sessionId].cancelled) {
          return { stopReason: "cancelled" };
        }
        break;
      }
      switch (message.type) {
        case "system":
          switch (message.subtype) {
            case "init":
              break;
            case "compact_boundary":
              break;
            default:
              unreachable(message as never);
          }
          break;
        case "result": {
          if (this.sessions[params.sessionId].cancelled) {
            return { stopReason: "cancelled" };
          }

          // todo!() how is rate-limiting handled?
          switch (message.subtype) {
            case "success": {
              if (message.result.includes("Please run /login")) {
                throw RequestError.authRequired();
              }
              return { stopReason: "end_turn" };
            }
            case "error_during_execution":
              return { stopReason: "refusal" };
            case "error_max_turns":
              return { stopReason: "max_turn_requests" };
            default:
              return { stopReason: "refusal" };
          }
        }
        case "user":
        case "assistant": {
          if (this.sessions[params.sessionId].cancelled) {
            break;
          }

          // Slash commands like /compact can generate invalid output... doesn't match
          // their own docs: https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-slash-commands#%2Fcompact-compact-conversation-history
          if (
            typeof message.message.content === "string" &&
            message.message.content.includes("<local-command-stdout>")
          ) {
            console.log(message.message.content);
            break;
          }

          if (
            typeof message.message.content === "string" &&
            message.message.content.includes("<local-command-stderr>")
          ) {
            console.error(message.message.content);
            break;
          }
          // Skip these user messages for now, since they seem to just be messages we don't want in the feed
          if (message.type === "user" && typeof message.message.content === "string") {
            break;
          }

          if (
            message.type === "assistant" &&
            message.message.model === "<synthetic>" &&
            Array.isArray(message.message.content) &&
            message.message.content.length === 1 &&
            message.message.content[0].type === "text" &&
            message.message.content[0].text.includes("Please run /login")
          ) {
            throw RequestError.authRequired();
          }

          for (const notification of toAcpNotifications(
            message,
            params.sessionId,
            this.toolUseCache,
            this.fileContentCache,
          )) {
            await this.client.sessionUpdate(notification);
          }
          break;
        }
        default:
          unreachable(message as never);
      }
    }
    throw new Error("Session did not end in result");
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    this.sessions[params.sessionId].cancelled = true;
    await this.sessions[params.sessionId].query.interrupt();
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    switch (params.modeId) {
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "plan":
        this.sessions[params.sessionId].permissionMode = params.modeId;
        await this.sessions[params.sessionId].query.setPermissionMode(params.modeId);
        return {};
      default:
        throw new Error("Invalid mode");
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    if (!params.limit && !params.line) {
      this.fileContentCache[params.path] = response.content;
    }
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    this.fileContentCache[params.path] = params.content;
    return response;
  }
}

async function getAvailableSlashCommands(query: Query): Promise<AvailableCommand[]> {
  const UNSUPPORTED_COMMANDS = [
    "add-dir",
    "agents", // Modal
    "bashes", // Modal
    "bug", // Modal
    "clear", // Escape Codes
    "config", // Modal
    "context", // Escape Codes
    "cost", // Escape Codes
    "doctor", // Escape Codes
    "exit",
    "export", // Modal
    "help", // Modal
    "hooks", // Modal
    "ide", // Modal
    "install-github-app", // Modal
    "login",
    "logout",
    "memory",
    "mcp",
    "migrate-installer", // Modal
    "model", // Not supported via SDK?
    "output-style", // Modal
    "output-style:new", // Modal
    "permissions", // Modal
    "privacy-settings",
    "release-notes", // Escape Codes
    "resume",
    "status", // Not supported via SDK?
    "statusline", // Not needed
    "terminal-setup", // Not needed
    "todos", // Escape Codes
    "vim", // Not needed
  ];
  const commands = await query.supportedCommands();

  return commands
    .map((command) => {
      const input = command.argumentHint ? { hint: command.argumentHint } : null;
      return {
        name: command.name,
        description: command.description || "",
        input,
      };
    })
    .filter(
      (command: AvailableCommand) =>
        !(command.name.match(/\(MCP\)/) || UNSUPPORTED_COMMANDS.includes(command.name)),
    );
}

function formatUriAsLink(uri: string): string {
  try {
    if (uri.startsWith("file://")) {
      const path = uri.slice(7); // Remove "file://"
      const name = path.split("/").pop() || path;
      return `[@${name}](${uri})`;
    } else if (uri.startsWith("zed://")) {
      const parts = uri.split("/");
      const name = parts[parts.length - 1] || uri;
      return `[@${name}](${uri})`;
    }
    return uri;
  } catch {
    return uri;
  }
}

function promptToClaude(prompt: PromptRequest): SDKUserMessage {
  const content: any[] = [];
  const context: any[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text":
        content.push({ type: "text", text: chunk.text });
        break;
      case "resource_link": {
        const formattedUri = formatUriAsLink(chunk.uri);
        content.push({
          type: "text",
          text: formattedUri,
        });
        break;
      }
      case "resource": {
        if ("text" in chunk.resource) {
          const formattedUri = formatUriAsLink(chunk.resource.uri);
          content.push({
            type: "text",
            text: formattedUri,
          });
          context.push({
            type: "text",
            text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
          });
        }
        // Ignore blob resources (unsupported)
        break;
      }
      case "image":
        if (chunk.data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              data: chunk.data,
              media_type: chunk.mimeType,
            },
          });
        } else if (chunk.uri && chunk.uri.startsWith("http")) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: chunk.uri,
            },
          });
        }
        break;
      // Ignore audio and other unsupported types
      default:
        break;
    }
  }

  content.push(...context);

  return {
    type: "user",
    message: {
      role: "user",
      content: content,
    },
    session_id: prompt.sessionId,
    parent_tool_use_id: null,
  };
}

/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  message: SDKAssistantMessage | SDKUserMessage | SDKUserMessageReplay,
  sessionId: string,
  toolUseCache: ToolUseCache,
  fileContentCache: { [key: string]: string },
): SessionNotification[] {
  const content = message.message.content;

  if (typeof content === "string") {
    return [
      {
        sessionId,
        update: {
          sessionUpdate:
            message.type === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "text",
            text: content,
          },
        },
      },
    ];
  }

  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
        update = {
          sessionUpdate:
            message.type === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "text",
            text: chunk.text,
          },
        };
        break;
      case "image":
        update = {
          sessionUpdate:
            message.type === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;
      case "thinking":
        update = {
          sessionUpdate: "agent_thought_chunk",
          content: {
            type: "text",
            text: chunk.thinking,
          },
        };
        break;
      case "tool_use":
        toolUseCache[chunk.id] = chunk;
        if (chunk.name === "TodoWrite") {
          update = {
            sessionUpdate: "plan",
            entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
          };
        } else {
          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }
          update = {
            toolCallId: chunk.id,
            sessionUpdate: "tool_call",
            rawInput,
            status: "pending",
            ...toolInfoFromToolUse(chunk, fileContentCache),
          };
        }
        break;

      case "tool_result": {
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          console.error(
            `[claude-code-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        if (toolUse.name !== "TodoWrite") {
          update = {
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: chunk.is_error ? "failed" : "completed",
            ...toolUpdateFromToolResult(chunk, toolUseCache[chunk.tool_use_id]),
          };
        }
        break;
      }

      default:
        throw new Error("unhandled chunk type: " + chunk.type);
    }
    if (update) {
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);
  new AgentSideConnection((client) => new ClaudeAcpAgent(client), stream);
}
