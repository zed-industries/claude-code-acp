import { HookCallback, HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { Logger } from "./acp-agent.js";

/**
 * Configuration for a hook that runs a command when triggered
 */
export type HookConfig = {
  /** The hook event to listen for */
  event: HookEvent;
  /** 
   * Optional matcher string to filter which tools trigger this hook.
   * Only relevant for tool-related hooks: PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest
   */
  matcher?: string;
  /** Command to execute */
  command: string;
  /** Arguments for the command */
  args?: string[];
  /** Environment variables to pass to the command */
  env?: Record<string, string>;
};

/**
 * Executes a command with the given arguments and environment
 */
async function executeCommand(
  command: string,
  args: string[],
  env: Record<string, string>,
  logger: Logger,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code });
    });

    child.on("error", (error) => {
      logger.error(`Failed to execute command: ${error.message}`);
      resolve({ stdout, stderr: error.message, exitCode: -1 });
    });
  });
}

/**
 * Creates a HookCallback from a HookConfig
 */
function createHookCallbackFromConfig(config: HookConfig, logger: Logger): HookCallback {
  return async (input: any, toolUseID: string | undefined) => {
    // Prepare base environment variables
    const env: Record<string, string> = {
      ...config.env,
      CLAUDE_CODE_HOOK_EVENT: input.hook_event_name || "",
      CLAUDE_CODE_SESSION_ID: input.session_id || "",
      CLAUDE_CODE_TRANSCRIPT_PATH: input.transcript_path || "",
      CLAUDE_CODE_CWD: input.cwd || "",
      CLAUDE_CODE_PERMISSION_MODE: input.permission_mode || "",
    };

    // Add tool use ID if available
    if (toolUseID) {
      env.CLAUDE_CODE_TOOL_USE_ID = toolUseID;
    }

    // Add hook-specific fields as environment variables
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && key !== "hook_event_name") {
        const envKey = `CLAUDE_CODE_${key.toUpperCase()}`;
        env[envKey] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }

    // Add tool input fields as nested environment variables (for tool-related hooks)
    if (input.tool_input && typeof input.tool_input === "object") {
      for (const [key, value] of Object.entries(input.tool_input)) {
        const envKey = `CLAUDE_CODE_TOOL_INPUT_${key.toUpperCase()}`;
        env[envKey] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }

    // Add tool response fields as nested environment variables (for PostToolUse)
    if (input.tool_response && typeof input.tool_response === "object") {
      for (const [key, value] of Object.entries(input.tool_response)) {
        const envKey = `CLAUDE_CODE_TOOL_RESPONSE_${key.toUpperCase()}`;
        env[envKey] = typeof value === "string" ? value : JSON.stringify(value);
      }
    }

    // Execute the command
    const description = input.tool_name
      ? `${config.event} on tool ${input.tool_name}`
      : config.event;
    logger.log(
      `[HookConfig] Executing hook for ${description}: ${config.command} ${(config.args || []).join(" ")}`,
    );

    const result = await executeCommand(config.command, config.args || [], env, logger);

    if (result.exitCode !== 0) {
      logger.error(
        `[HookConfig] Hook command failed with exit code ${result.exitCode}: ${result.stderr}`,
      );
    } else if (result.stdout) {
      logger.log(`[HookConfig] Hook command output: ${result.stdout}`);
    }

    // Parse the JSON output to determine the return type
    try {
      const output = result.stdout.trim();
      if (output) {
        const parsed = JSON.parse(output);
        return parsed;
      }
    } catch (error) {
      logger.error(
        `[HookConfig] Failed to parse hook output as JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // Default to continue: true if parsing fails or no output
    return { continue: true };
  };
}

/**
 * Transforms an array of HookConfigs into hook callbacks that can be used in Options
 */
export function transformHookConfigs(
  configs: HookConfig[],
  logger: Logger = console,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};

  for (const config of configs) {
    const callback = createHookCallbackFromConfig(config, logger);
    const matcher: HookCallbackMatcher = {
      matcher: config.matcher,
      hooks: [callback],
    };

    // Initialize the array for this event if it doesn't exist
    if (!hooks[config.event]) {
      hooks[config.event] = [];
    }

    hooks[config.event]!.push(matcher);
  }

  return hooks;
}

