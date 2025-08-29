import {
  Agent,
  AgentSideConnection,
  AuthenticateRequest,
  CancelNotification,
  Client,
  ClientCapabilities,
  CommandInfo,
  InitializeRequest,
  InitializeResponse,
  ListCommandsRequest,
  ListCommandsResponse,
  LoadSessionRequest,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  RunCommandRequest,
  ToolCallContent,
  ToolKind,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@zed-industries/agent-client-protocol";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  McpServerConfig,
  Options,
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
  fileContentCache: { [key: string]: any };
  clientCapabilities?: ClientCapabilities;

  constructor(client: Client) {
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
          supportsCommands: true,
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
      disallowedTools: [],
      permissionPromptToolName: "mcp__acp__permission",
      stderr: (err) => console.error(err),
    };
    if (this.clientCapabilities?.fs?.readTextFile) {
      options.allowedTools = ["mcp__acp__read"];
      options.disallowedTools!.push("Read");
    }
    if (this.clientCapabilities?.fs?.writeTextFile) {
      options.disallowedTools!.push("Write", "Edit", "MultiEdit");
    }

    let q = query({
      prompt: input,
      options,
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

  async listCommands(
    params: ListCommandsRequest,
  ): Promise<ListCommandsResponse> {
    const embeddedCommands = buildEmbeddedCommands();
    const customCommands = await buildCustomCommands();
    const commands = [...embeddedCommands, ...customCommands];
    commands.sort((a, b) => a.name.localeCompare(b.name));
    return { commands };
  }

  async runCommand(params: RunCommandRequest): Promise<void> {
    console.error(
      `Running command ${params.command} with arguments ${params.args}`,
    );
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

function buildEmbeddedCommands(): CommandInfo[] {
  // Based on https://docs.anthropic.com/en/docs/claude-code/slash-commands
  return [
    {
      name: "compact",
      description: "Compact conversation with optional focus instructions",
      requiresArgument: false,
    },
    {
      name: "cost",
      description: "Show token usage statistics",
      requiresArgument: false,
    },
    {
      name: "doctor",
      description: "Check the health of your Claude Code installation",
      requiresArgument: false,
    },
    {
      name: "init",
      description: "Initialize project with CLAUDE.md guide",
      requiresArgument: false,
    },
    {
      name: "pr_comments",
      description: "View pull request comments",
      requiresArgument: false,
    },
    {
      name: "review",
      description: "Request code review",
      requiresArgument: false,
    },
  ];
}

async function buildCustomCommands(): Promise<CommandInfo[]> {
  const commands: CommandInfo[] = [];

  // Get paths to scan for custom commands
  const projectCommandsDir = path.join(process.cwd(), ".claude", "commands");
  const userCommandsDir = path.join(os.homedir(), ".claude", "commands");

  // Scan project commands
  const projectCommands = await scanCommandDirectory(
    projectCommandsDir,
    "project",
  );
  commands.push(...projectCommands);

  // Scan user commands
  const userCommands = await scanCommandDirectory(userCommandsDir, "user");
  commands.push(...userCommands);

  return commands;
}

async function scanCommandDirectory(
  dirPath: string,
  scope: "project" | "user",
): Promise<CommandInfo[]> {
  const commands: CommandInfo[] = [];

  try {
    // Check if directory exists
    await fs.access(dirPath);

    // Recursively scan for .md files
    const mdFiles = await findMarkdownFiles(dirPath);

    for (const filePath of mdFiles) {
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const relativePath = path.relative(dirPath, filePath);
        const command = parseCommandFile(content, relativePath, scope);
        if (command) {
          commands.push(command);
        }
      } catch (error) {
        console.error(`Error reading command file ${filePath}:`, error);
      }
    }
  } catch (error) {
    // Directory doesn't exist or can't be accessed - that's ok
  }

  return commands;
}

async function findMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        const subFiles = await findMarkdownFiles(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  } catch (error) {
    // Error reading directory - skip it
  }

  return files;
}

export function parseCommandFile(
  content: string,
  relativePath: string,
  scope: "project" | "user",
): CommandInfo | null {
  try {
    // Extract command name from file path
    const commandName = path.basename(relativePath, ".md");

    // Parse frontmatter for metadata
    const frontmatter = parseFrontmatter(content);

    // Get description from frontmatter or first line of content
    let description = frontmatter.description;
    if (!description) {
      // Skip frontmatter section and find first content line
      const lines = content.split("\n");
      let inFrontmatter = false;
      let frontmatterEnded = false;

      for (const line of lines) {
        const trimmed = line.trim();

        // Track frontmatter boundaries
        if (trimmed === "---") {
          if (!inFrontmatter && !frontmatterEnded) {
            inFrontmatter = true;
            continue;
          } else if (inFrontmatter) {
            inFrontmatter = false;
            frontmatterEnded = true;
            continue;
          }
        }

        // Skip lines inside frontmatter
        if (inFrontmatter) {
          continue;
        }

        // Only look for description after frontmatter (if any)
        if (trimmed && !trimmed.startsWith("#")) {
          description = trimmed;
          break;
        }
      }
    }

    // Build scope indicator for description
    const dirname = path.dirname(relativePath);
    const scopeIndicator =
      dirname === "."
        ? `(${scope})`
        : `(${scope}:${dirname.replace(/\//g, ":")})`;

    return {
      name: commandName,
      description: `${description || "Custom command"} ${scopeIndicator}`,
      requiresArgument: !!frontmatter["argument-hint"],
    };
  } catch (error) {
    console.error(`Error parsing command content:`, error);
    return null;
  }
}

export function parseFrontmatter(content: string): Record<string, string> {
  const frontmatter: Record<string, string> = {};

  // Check if content starts with frontmatter delimiter
  if (!content.startsWith("---")) {
    return frontmatter;
  }

  // Find the closing delimiter
  const lines = content.split("\n");
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (i === 0 && line === "---") {
      inFrontmatter = true;
      continue;
    }

    if (inFrontmatter && line === "---") {
      break;
    }

    if (inFrontmatter) {
      // Parse key: value pairs
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        frontmatter[key] = value;
      }
    }
  }

  return frontmatter;
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
  fileContentCache: { [key: string]: string },
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
            ...toolInfoFromToolUse(chunk, fileContentCache),
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
