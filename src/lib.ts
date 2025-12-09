// Export the main agent class and utilities for library usage
export {
  ClaudeAcpAgent,
  runAcp,
  toAcpNotifications,
  streamEventToAcpNotifications,
  type ToolUpdateMeta,
  type NewSessionMeta,
} from "./acp-agent.js";
export {
  loadManagedSettings,
  applyEnvironmentSettings,
  nodeToWebReadable,
  nodeToWebWritable,
  Pushable,
  unreachable,
} from "./utils.js";
export { createMcpServer, toolNames } from "./mcp-server.js";
export {
  toolInfoFromToolUse,
  planEntries,
  toolUpdateFromToolResult,
  createPreToolUseHook,
} from "./tools.js";
export {
  SettingsManager,
  type ClaudeCodeSettings,
  type PermissionSettings,
  type PermissionDecision,
  type PermissionCheckResult,
  type SettingsManagerOptions,
} from "./settings.js";

// Export types
export type { ClaudePlanEntry } from "./tools.js";
