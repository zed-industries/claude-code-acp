import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  TerminalHandle,
  TerminalOutputResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@zed-industries/agent-client-protocol";
import {
  McpServerConfig,
  Options,
  Query,
  query,
  SDKAssistantMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-code";
import { v7 as uuidv7 } from "uuid";
import {
  nodeToWebReadable,
  nodeToWebWritable,
  Pushable,
  unreachable,
} from "./utils.js";
import { SessionNotification } from "@zed-industries/agent-client-protocol";
import { createMcpServer } from "./mcp-server.js";
import { AddressInfo } from "node:net";
import {
  toolInfoFromToolUse,
  planEntries,
  toolUpdateFromToolResult,
} from "./tools.js";

type Session = {
  query: Query;
  input: Pushable<SDKUserMessage>;
  cancelled: boolean;
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

// Implement the ACP Agent interface
export class ClaudeAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: AgentSideConnection;
  toolUseCache: { [key: string]: any };
  fileContentCache: { [key: string]: any };
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
      },
      authMethods: [
        {
          description: "Run `claude /login` in the terminal",
          name: "Login with Claude CLI",
          id: "claude-login",
        },
        {
          description: "Anthropic API KEY",
          name: "Use Anthropic API Key",
          id: "anthropic-api-key",
        },
      ],
    };
  }
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    let sessionId = uuidv7();
    let input = new Pushable<SDKUserMessage>();

    const mcpServers: Record<string, McpServerConfig> = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
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

    let server = await createMcpServer(
      this,
      sessionId,
      this.clientCapabilities,
    );
    let address = server.address() as AddressInfo;
    mcpServers["acp"] = {
      type: "http",
      url: "http://127.0.0.1:" + address.port + "/mcp",
      headers: {
        "x-acp-proxy-session-id": sessionId,
      },
    };

    let options: Options = {
      cwd: params.cwd,
      mcpServers,
      permissionPromptToolName: "mcp__acp__permission",
      stderr: (err) => console.error(err),
    };

    const allowedTools = [];
    const disallowedTools = [];
    if (this.clientCapabilities?.fs?.readTextFile) {
      allowedTools.push("mcp__acp__read");
      disallowedTools.push("Read");
    }
    if (this.clientCapabilities?.fs?.writeTextFile) {
      allowedTools.push("mcp__acp__write");
      disallowedTools.push("Write", "Edit", "MultiEdit");
    }
    if (this.clientCapabilities?.terminal) {
      allowedTools.push("mcp__acp__BashOutput", "mcp__acp__KillBash");
      disallowedTools.push("Bash", "BashOutput", "KillBash");
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
    };

    const availableCommands = await availableSlashCommands(q);
    return {
      sessionId,
      availableCommands,
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
      let { value: message, done } = await query.next();
      if (done || !message) {
        if (this.sessions[params.sessionId].cancelled) {
          return { stopReason: "cancelled" };
        }
        break;
      }
      switch (message.type) {
        case "system":
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
            continue;
          }

          if (
            message.message.model == "<synthetic>" &&
            message.message.content.length == 1 &&
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
          unreachable(message);
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

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    let response = await this.client.readTextFile(params);
    if (!params.limit && !params.line) {
      this.fileContentCache[params.path] = response.content;
    }
    return response;
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    let response = await this.client.writeTextFile(params);
    this.fileContentCache[params.path] = params.content;
    return response;
  }
}

async function availableSlashCommands(
  query: Query,
): Promise<AvailableCommand[]> {
  const UNSUPPORTED_COMMANDS = [
    "agents", // Modal
    "bashes", // Modal
    "bug", // Modal
    "clear", // Escape Codes
    "compact", // Not supported via SDK?
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
    "mcp",
    "migrate-installer", // Modal
    "model", // Not supported via SDK?
    "output-style", // Modal
    "output-style:new", // Modal
    "permissions", // Modal
    "release-notes", // Escape Codes
    "resume",
    "status", // Not supported via SDK?
    "statusline", // Not needed
    "terminal-setup", // Not needed
    "todos", // Escape Codes
    "vim", // Not needed
  ];

  //todo: Do not use `as any` once `supportedCommands` is exposed via the typescript interface
  const commands = await (query as any).supportedCommands();
  return commands
    .map(
      (command: {
        name: string;
        description: string;
        argumentHint: string;
      }) => {
        const input = command.argumentHint
          ? { hint: command.argumentHint }
          : null;
        return {
          name: command.name,
          description: command.description || "",
          input,
        };
      },
    )
    .filter(
      (command: AvailableCommand) =>
        !UNSUPPORTED_COMMANDS.includes(command.name),
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
  message: SDKAssistantMessage | SDKUserMessage,
  sessionId: string,
  toolUseCache: {
    [key: string]: { type: "tool_use"; id: string; name: string; input: any };
  },
  fileContentCache: { [key: string]: string },
): SessionNotification[] {
  let chunks = message.message.content as ContentChunk[];
  let output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of chunks) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
        update = {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: chunk.text,
          },
        };
        break;
      case "image":
        update = {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType:
              chunk.source.type === "base64" ? chunk.source.media_type : "",
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
        if (chunk.name == "TodoWrite") {
          update = {
            sessionUpdate: "plan",
            entries: planEntries(chunk.input),
          };
        } else {
          update = {
            toolCallId: chunk.id,
            sessionUpdate: "tool_call",
            rawInput: chunk.input,
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
  new AgentSideConnection(
    (client) => new ClaudeAcpAgent(client),
    nodeToWebWritable(process.stdout),
    nodeToWebReadable(process.stdin),
  );
}

type ContentChunk =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: any } // input is serde_json::Value, so use any or unknown
  | {
      type: "tool_result";
      content: string;
      tool_use_id: string;
      is_error: boolean;
    } // content type depends on your Content definition
  | { type: "thinking"; thinking: string }
  | { type: "redacted_thinking" }
  | { type: "image"; source: ImageSource }
  | { type: "document" }
  | { type: "web_search_tool_result" }
  | { type: "untagged_text"; text: string };

// Example ImageSource type (adjust as needed)
type ImageSource =
  | { type: "base64"; data: string; media_type: string }
  | { type: "url"; url: string };
