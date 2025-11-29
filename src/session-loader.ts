import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { Logger } from "./acp-agent.js";
import { SDKUserMessage, SDKPartialAssistantMessage, Options } from "@anthropic-ai/claude-agent-sdk";

// NOTE: This is a simplified version of the session loading logic.
// It does not handle all edge cases and assumes a specific project structure.

export class SessionLoader {
  logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<{ messages: (SDKUserMessage | SDKPartialAssistantMessage)[]; options: Options } | null> {
    const projectName = path.basename(cwd);
    const sessionPath = path.join(
      os.homedir(),
      ".claude",
      "projects",
      projectName,
      `${sessionId}.jsonl`,
    );

    try {
      const fileContent = await fs.readFile(sessionPath, "utf-8");

      if (!fileContent.trim()) {
        this.logger.error(`[claude-code-acp] Session file is empty: ${sessionPath}`);
        return null;
      }

      const lines = fileContent.trim().split("\n");
      const messages: (SDKUserMessage | SDKPartialAssistantMessage)[] = lines.map((line) => JSON.parse(line));

      if (messages.length === 0) {
        this.logger.error(`[claude-code-acp] Session file is empty: ${sessionPath}`);
        return null;
      }

      // Reconstruct options from the first message if possible.
      // This is a simplification and might not fully represent the original options.
      const firstMessage = messages[0];
      const options: Options = {
        cwd,
        //
        // cast as any because the type definitions are out of date
        // permissionMode is a valid option
        permissionMode: (firstMessage as any)["permissionMode"] || "default",
        // Add other options that might be stored or inferred
      };

      return { messages, options };
    } catch (error) {
      this.logger.error(`[claude-code-acp] Error loading session: ${error}`);
      return null;
    }
  }
}
