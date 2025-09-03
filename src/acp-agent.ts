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
import { spawn, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { v7 as uuidv7 } from "uuid";
import { nodeToWebReadable, nodeToWebWritable, Pushable, sleep, unreachable } from "./utils.js";
import { SessionNotification } from "@zed-industries/agent-client-protocol";
import { createMcpServer } from "./mcp-server.js";
import { AddressInfo } from "node:net";
import { toolInfoFromToolUse, planEntries, toolUpdateFromToolResult } from "./tools.js";

// Types for Claude command JSON streaming
type ClaudeMessage = {
  type: "user" | "assistant" | "system";
  message: {
    role: "user" | "assistant" | "system";
    content: any[];
  };
  session_id?: string;
  parent_tool_use_id?: string | null;
};

type ClaudeResult = {
  type: "result";
  subtype: "success" | "error_during_execution" | "error_max_turns";
  result?: string;
};

type Session = {
  mcpEnvVars: { [key: string]: string };
  cwd?: string;
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
    
    // Bind all methods to ensure they're properly accessible to ACP library
    this.initialize = this.initialize.bind(this);
    this.newSession = this.newSession.bind(this);
    this.prompt = this.prompt.bind(this);
    this.cancel = this.cancel.bind(this);
    this.readTextFile = this.readTextFile.bind(this);
    this.writeTextFile = this.writeTextFile.bind(this);
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;
    return {
      protocolVersion: 1,
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
    const sessionId = uuidv7();

    // Prepare MCP servers configuration
    const mcpEnvVars: { [key: string]: string } = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        // Convert MCP servers to environment variables or config file
        // This is a simplified approach - you may need to adjust based on how claude command handles MCP
        mcpEnvVars[`MCP_${server.name.toUpperCase()}_COMMAND`] = server.command;
        if (server.args) {
          mcpEnvVars[`MCP_${server.name.toUpperCase()}_ARGS`] = server.args.join(' ');
        }
      }
    }

    const server = await createMcpServer(this, sessionId, this.clientCapabilities);
    const address = server.address() as AddressInfo;
    mcpEnvVars['MCP_ACP_URL'] = `http://127.0.0.1:${address.port}/mcp`;
    mcpEnvVars['MCP_ACP_SESSION_ID'] = sessionId;

    this.sessions[sessionId] = {
      mcpEnvVars,
      cwd: params.cwd,
      cancelled: false,
    };

    const availableCommands = await this.getAvailableCommands();
    return {
      sessionId,
      availableCommands,
    };
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    // For now, we assume authentication is handled via Claude CLI login
    // This method is required by the Agent interface but not used in our implementation
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }

    this.sessions[params.sessionId].cancelled = false;

    const session = this.sessions[params.sessionId];

    // Spawn a new Claude process for each prompt (--print mode doesn't stay alive)
    const claudeArgs = [
      '--print',
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--verbose'
    ];

    // Note: Claude CLI doesn't support --cwd flag, the working directory
    // should be set via process spawn options instead

    console.error(`Spawning Claude with args: ${claudeArgs.join(' ')}`);
    
    // Ensure Claude authentication environment is preserved
    const claudeEnv = {
      ...process.env, // Start with all env vars
      ...session.mcpEnvVars // Add MCP-specific vars
    };
    
    // Remove API key env vars that might interfere with logged-in session
    delete claudeEnv.ANTHROPIC_API_KEY;
    delete claudeEnv.CLAUDE_API_KEY;
    
    // Ensure Claude-specific auth env vars are present
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    if (process.env.CLAUDE_CODE_ENTRYPOINT) {
      claudeEnv.CLAUDE_CODE_ENTRYPOINT = process.env.CLAUDE_CODE_ENTRYPOINT;
    }
    if (process.env.CLAUDECODE) {
      claudeEnv.CLAUDECODE = process.env.CLAUDECODE;
    }
    
    console.error(`Claude auth env vars: OAUTH_TOKEN=${!!claudeEnv.CLAUDE_CODE_OAUTH_TOKEN}, ENTRYPOINT=${claudeEnv.CLAUDE_CODE_ENTRYPOINT}, CLAUDECODE=${claudeEnv.CLAUDECODE}`);
    
    const claudeProcess = spawn('claude', claudeArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: claudeEnv,
      cwd: session.cwd  // Set working directory via spawn options instead
    });

    console.error(`Claude process spawned with PID: ${claudeProcess.pid}`);

    return new Promise((resolve, reject) => {
      let outputBuffer = '';
      let hasReceivedResult = false;
      let isResolved = false;

      const cleanup = () => {
        claudeProcess.stdout?.removeAllListeners('data');
        claudeProcess.stderr?.removeAllListeners('data');
        claudeProcess.removeAllListeners('error');
        claudeProcess.removeAllListeners('exit');
        if (!claudeProcess.killed) {
          claudeProcess.kill();
        }
      };

      const safeResolve = (response: PromptResponse) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          resolve(response);
        }
      };

      const safeReject = (error: Error) => {
        if (!isResolved) {
          isResolved = true;
          cleanup();
          reject(error);
        }
      };

      // Add timeout to prevent hanging
      const timeout = setTimeout(() => {
        safeReject(new Error('Claude process timeout - no response received within 30 seconds'));
      }, 30000);

      const handleOutput = (data: Buffer) => {
        const dataStr = data.toString();
        console.error(`Claude stdout: ${dataStr.trim()}`);
        outputBuffer += dataStr;
        
        // Process complete JSON lines
        const lines = outputBuffer.split('\n');
        outputBuffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const message = JSON.parse(line);
            console.error(`Parsed Claude message:`, JSON.stringify(message, null, 2));
            this.handleClaudeMessage(message, params.sessionId, safeResolve, safeReject);
            
            if (message.type === 'result') {
              hasReceivedResult = true;
              clearTimeout(timeout);
            }
          } catch (error) {
            console.error('Failed to parse Claude output:', line, error);
          }
        }
      };

      const handleError = (error: Error) => {
        console.error('Claude process error:', error);
        clearTimeout(timeout);
        safeReject(error);
      };

      const handleExit = (code: number | null, signal: string | null) => {
        console.error(`Claude process exited with code ${code}, signal ${signal}`);
        clearTimeout(timeout);
        if (!hasReceivedResult && !isResolved) {
          // Claude exits with code 1 even for successful error responses (like "credit balance too low")
          // Only treat it as an error if we didn't get any JSON response at all
          if (code === 0 || code === 1) {
            safeResolve({ stopReason: "end_turn" });
          } else {
            safeReject(new Error(`Claude process exited with code ${code}, signal ${signal}`));
          }
        }
      };

      claudeProcess.stdout?.on('data', handleOutput);
      claudeProcess.stderr?.on('data', (data) => {
        console.error(`Claude stderr: ${data.toString().trim()}`);
      });
      claudeProcess.on('error', handleError);
      claudeProcess.on('exit', handleExit);

      // Send the user message to Claude immediately
      try {
        const claudeMessage = promptToClaude(params);
        const messageJson = JSON.stringify(claudeMessage) + '\n';
        console.error(`Sending to Claude: ${messageJson.trim()}`);
        
        claudeProcess.stdin?.write(messageJson);
        claudeProcess.stdin?.end(); // Close stdin to signal we're done sending input
      } catch (error) {
        console.error('Failed to send message to Claude:', error);
        safeReject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async cancel(params: CancelNotification): Promise<void> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    this.sessions[params.sessionId].cancelled = true;
    
    // Note: In the new approach, we spawn a new process for each prompt
    // so cancellation is handled by the cleanup in the prompt method
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

  private async getAvailableCommands(): Promise<AvailableCommand[]> {
    // For now, return a basic set of commands
    // You may need to implement a specific protocol to get available commands from claude CLI
    return this.getBasicCommands();
  }

  private getBasicCommands(): AvailableCommand[] {
    // Return basic commands for now - you can expand this
    return [
      {
        name: "quick-math",
        description: "Perform quick math calculations",
        input: null,
      },
      {
        name: "say-hello", 
        description: "Say hello with optional name",
        input: { hint: "[name]" },
      }
    ];
  }

  private async handleClaudeMessage(
    message: any,
    sessionId: string,
    resolve: (value: PromptResponse) => void,
    reject: (error: Error) => void
  ) {
    console.error(`handleClaudeMessage: Processing message type: ${message.type}`);
    
    if (this.sessions[sessionId]?.cancelled) {
      console.error(`handleClaudeMessage: Session cancelled`);
      resolve({ stopReason: "cancelled" });
      return;
    }

    switch (message.type) {
      case "system":
        console.error(`handleClaudeMessage: System message - subtype: ${message.subtype}`);
        // Handle system messages
        break;
      case "result": {
        // Handle result messages
        switch (message.subtype) {
          case "success": {
            if (message.result?.includes("Please run /login")) {
              reject(RequestError.authRequired());
              return;
            }
            if (message.result?.includes("Credit balance is too low")) {
              reject(RequestError.authRequired()); // Treat as auth issue
              return;
            }
            resolve({ stopReason: "end_turn" });
            return;
          }
          case "error_during_execution":
            resolve({ stopReason: "refusal" });
            return;
          case "error_max_turns":
            resolve({ stopReason: "max_turn_requests" });
            return;
          default:
            resolve({ stopReason: "refusal" });
            return;
        }
      }
      case "user":
      case "assistant": {
        console.error(`handleClaudeMessage: Assistant/User message - content length: ${message.message?.content?.length}`);
        
        // Convert to ACP notifications and send to client
        if (
          message.message?.model === "<synthetic>" &&
          message.message?.content?.length === 1 &&
          message.message.content[0].text?.includes("Please run /login")
        ) {
          console.error(`handleClaudeMessage: Login required detected`);
          reject(RequestError.authRequired());
          return;
        }
        
        console.error(`handleClaudeMessage: Converting to ACP notifications...`);
        const notifications = toAcpNotifications(
          message,
          sessionId,
          this.toolUseCache,
          this.fileContentCache,
        );
        
        console.error(`handleClaudeMessage: Generated ${notifications.length} notifications`);
        for (const notification of notifications) {
          console.error(`handleClaudeMessage: Sending notification:`, JSON.stringify(notification, null, 2));
          await this.client.sessionUpdate(notification);
        }
        break;
      }
      default:
        console.warn('Unknown message type:', message.type);
        break;
    }
  }

  // Keep the UNSUPPORTED_COMMANDS array for reference
  private static UNSUPPORTED_COMMANDS = [
    "add-dir",
    "agents",
    "bashes", 
    "bug",
    "clear",
    "compact",
    "config",
    "context",
    "cost",
    "doctor",
    "exit",
    "export",
    "help",
    "hooks",
    "ide",
    "install-github-app",
    "login",
    "logout",
    "memory",
    "mcp",
    "migrate-installer",
    "model",
    "output-style",
    "output-style:new",
    "permissions",
    "privacy-settings",
    "release-notes",
    "resume",
    "status",
    "statusline",
    "terminal-setup",
    "todos",
    "vim",
  ];
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

function promptToClaude(prompt: PromptRequest): ClaudeMessage {
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
  message: any,
  sessionId: string, 
  toolUseCache: ToolUseCache,
  fileContentCache: { [key: string]: string },
): SessionNotification[] {
  console.error(`toAcpNotifications: Message structure:`, JSON.stringify(message, null, 2));
  const chunks = message.message.content as ContentChunk[];
  console.error(`toAcpNotifications: Found ${chunks?.length} chunks`);
  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of chunks) {
    console.error(`toAcpNotifications: Processing chunk:`, JSON.stringify(chunk, null, 2));
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
  | { type: "tool_use"; id: string; name: string; input: any }
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