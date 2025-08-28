import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  Client,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestError,
  ToolCallContent,
  ToolKind,
} from "@zed-industries/agent-client-protocol";
import {
  McpServerConfig,
  Query,
  query,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-code";
import * as readline from "node:readline";
import { v7 as uuidv7 } from "uuid";
import {
  nodeToWebReadable,
  nodeToWebWritable,
  Pushable,
  unreachable,
} from "./utils.js";
import { ContentBlock } from "@zed-industries/agent-client-protocol";
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

// Implement the ACP Agent interface
export class ClaudeAcpAgent implements Agent {
  sessions: {
    [key: string]: Session;
  };
  client: Client;
  toolUseCache: { [key: string]: any };

  constructor(client: Client) {
    this.sessions = {};
    this.client = client;
    this.toolUseCache = {};
  }
  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      // todo!()
      agentCapabilities: {
        promptCapabilities: { image: true, embeddedContext: true },
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

    // todo!() auth
    let server = await createMcpServer(this, sessionId);
    let address = server.address() as AddressInfo;
    mcpServers["acp"] = {
      type: "http",
      url: "http://127.0.0.1:" + address.port + "/mcp",
      headers: {
        "x-acp-proxy-session-id": sessionId,
      },
    };

    let q = query({
      prompt: input,
      options: {
        cwd: params.cwd,
        mcpServers,
        allowedTools: ["mcp__acp__read"],
        disallowedTools: ["Read", "Write", "Edit", "MultiEdit"],
        strictMcpConfig: true,
        permissionPromptToolName: "mcp__acp__permission",
        stderr: (err) => console.error(err),
      },
    });
    this.sessions[sessionId] = {
      query: q,
      input: input,
      cancelled: false,
    };

    return {
      sessionId,
    };
  }

  async authenticate(params: AuthenticateRequest): Promise<void> {
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
  toolUseCache: { [key: string]: any },
): SessionNotification[] {
  let chunks = message.message.content as ContentChunk[];
  let output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of chunks) {
    let update: SessionNotification["update"];
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
            ...toolInfoFromToolUse(chunk),
          };
        }
        break;

      case "tool_result":
        update = {
          toolCallId: chunk.tool_use_id,
          sessionUpdate: "tool_call_update",
          status: chunk.is_error ? "failed" : "completed",
          ...toolUpdateFromToolResult(chunk, toolUseCache[chunk.tool_use_id]),
        };
        break;

      default:
        throw new Error("unhandled chunk type: " + chunk.type);
    }
    output.push({ sessionId, update });
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
