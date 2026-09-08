import type {
  AccountInfo,
  McpServerStatus,
  ModelInfo,
  Query,
  SDKControlGetUsageResponse,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import { EFFORT_CONFIG_ID } from "./session-config-ids.js";
import {
  fetchStructuredUsage,
  formatCount,
  formatDuration,
  formatReset,
  usageBar,
} from "./usage-markdown.js";

type StatusLogger = { error(...args: unknown[]): void };

export type StatusSession = {
  query: Query;
  abortController: AbortController;
  cwd: string;
  models: { currentModelId: string };
  modelInfos: ModelInfo[];
  modes: SessionModeState;
  configOptions: SessionConfigOption[];
  contextUsedTokens?: number;
  contextWindowSize: number;
  claudeCodeVersion?: string;
};

export type BuildStatusMarkdownOptions = {
  sessionId: string;
  session: StatusSession;
  adapterVersion: string;
  hiddenMcpServerNames?: readonly string[];
  logger: StatusLogger;
};

export type StatusMarkdownInput = {
  sessionId: string;
  model: string;
  mode: string;
  effort?: string;
  account?: AccountInfo;
  cwd: string;
  contextUsed?: number;
  contextSize: number;
  usage?: SDKControlGetUsageResponse;
  mcpServers: readonly McpServerStatus[];
  claudeCodeVersion?: string;
  adapterVersion: string;
};

export function isStatusCommand(text: string): boolean {
  return text.trim() === "/status";
}

/** Collect the structured status sources and render their combined snapshot.
 * This keeps SDK parsing and presentation out of the central prompt handler. */
export async function buildStatusMarkdown({
  sessionId,
  session,
  adapterVersion,
  hiddenMcpServerNames = [],
  logger,
}: BuildStatusMarkdownOptions): Promise<string> {
  const [usage, account, mcpServers] = await Promise.all([
    fetchStructuredUsage(session.query, session.abortController.signal, logger, "/status"),
    session.query.accountInfo().catch((error) => {
      logger.error(`Failed to inspect account for /status: ${error}`);
      return undefined;
    }),
    session.query.mcpServerStatus().catch((error) => {
      logger.error(`Failed to inspect MCP servers for /status: ${error}`);
      return [] as McpServerStatus[];
    }),
  ]);
  const model = session.modelInfos.find((item) => item.value === session.models.currentModelId);
  const mode = session.modes.availableModes.find((item) => item.id === session.modes.currentModeId);
  const effort = session.configOptions.find((option) => option.id === EFFORT_CONFIG_ID);

  return formatStatusMarkdown({
    sessionId,
    model: model?.displayName ?? session.models.currentModelId,
    mode: mode?.name ?? session.modes.currentModeId,
    ...(typeof effort?.currentValue === "string" && effort.currentValue !== "default"
      ? { effort: effort.currentValue }
      : {}),
    account,
    cwd: session.cwd,
    contextUsed: session.contextUsedTokens,
    contextSize: session.contextWindowSize,
    usage: usage ?? undefined,
    mcpServers: mcpServers.filter((server) => !hiddenMcpServerNames.includes(server.name)),
    claudeCodeVersion: session.claudeCodeVersion,
    adapterVersion,
  });
}

function inlineCode(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  let fence = "`";
  while (normalized.includes(fence)) fence += "`";
  const padding = normalized.startsWith("`") || normalized.endsWith("`") ? " " : "";
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>|])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

function accountSummary(account: AccountInfo | undefined): string {
  if (!account) return "Unavailable";
  const parts: string[] = [];
  if (account.subscriptionType) parts.push(`Claude ${titleCase(account.subscriptionType)}`);
  if (account.email) parts.push(inlineCode(account.email));
  if (account.organization) parts.push(escapeMarkdown(account.organization));
  if (parts.length === 0 && account.apiProvider) parts.push(titleCase(account.apiProvider));
  if (parts.length === 0 && account.tokenSource) parts.push(account.tokenSource);
  return parts.join(" · ") || "Unavailable";
}

function appendProgress(lines: string[], label: string, percent: number, suffix = ""): void {
  lines.push("", `**${label} — ${percent}%${suffix}**`, `\`${usageBar(percent)}\``);
}

function totalSessionTokens(usage: SDKControlGetUsageResponse): number {
  return Object.values(usage.session.model_usage).reduce(
    (total, model) =>
      total +
      model.inputTokens +
      model.outputTokens +
      model.cacheReadInputTokens +
      model.cacheCreationInputTokens,
    0,
  );
}

function mcpSummary(servers: readonly McpServerStatus[]): string {
  if (servers.length === 0) return "None configured";
  const order: McpServerStatus["status"][] = [
    "connected",
    "needs-auth",
    "pending",
    "failed",
    "disabled",
  ];
  const labels: Record<McpServerStatus["status"], string> = {
    connected: "connected",
    "needs-auth": "auth required",
    pending: "connecting",
    failed: "failed",
    disabled: "disabled",
  };
  const parts = order.flatMap((status) => {
    const count = servers.filter((server) => server.status === status).length;
    return count === 0 ? [] : [`${count} ${labels[status]}`];
  });
  const toolCount = servers.reduce((total, server) => total + (server.tools?.length ?? 0), 0);
  if (toolCount > 0) parts.push(`${toolCount} ${toolCount === 1 ? "tool" : "tools"}`);
  return parts.join(" · ");
}

export function formatStatusMarkdown(status: StatusMarkdownInput): string {
  const lines = [
    "## Status",
    "",
    `**Model:** ${escapeMarkdown(status.model)} · ${escapeMarkdown(titleCase(status.mode))} mode${status.effort ? ` · ${escapeMarkdown(titleCase(status.effort))} effort` : ""}`,
    `**Account:** ${accountSummary(status.account)}`,
    `**Workspace:** ${inlineCode(status.cwd)}`,
    `**Session:** ${inlineCode(status.sessionId)}`,
    "",
    "### Usage",
  ];

  if (status.contextUsed !== undefined && status.contextSize > 0) {
    const percent = Math.max(
      0,
      Math.min(100, Math.round((status.contextUsed / status.contextSize) * 100)),
    );
    appendProgress(
      lines,
      `Context — ${formatCount(status.contextUsed)} / ${formatCount(status.contextSize)}`,
      percent,
    );
  } else {
    lines.push("", "**Context:** Available after the first model response");
  }

  const limits = status.usage?.rate_limits_available ? status.usage.rate_limits : undefined;
  if (limits?.five_hour?.utilization !== null && limits?.five_hour?.utilization !== undefined) {
    appendProgress(
      lines,
      "5-hour limit",
      limits.five_hour.utilization,
      formatReset(limits.five_hour.resets_at),
    );
  }
  if (limits?.seven_day?.utilization !== null && limits?.seven_day?.utilization !== undefined) {
    appendProgress(
      lines,
      "Weekly limit",
      limits.seven_day.utilization,
      formatReset(limits.seven_day.resets_at),
    );
  }

  if (status.usage) {
    lines.push(
      "",
      `**Session:** $${status.usage.session.total_cost_usd.toFixed(2)} · ${formatCount(totalSessionTokens(status.usage))} tokens · API ${formatDuration(status.usage.session.total_api_duration_ms)} · Active ${formatDuration(status.usage.session.total_duration_ms)}`,
    );
  } else {
    lines.push("", "**Session usage:** Unavailable");
  }

  lines.push("", `**MCP:** ${mcpSummary(status.mcpServers)}`);
  const runtime = [
    status.claudeCodeVersion ? `Claude Code ${status.claudeCodeVersion}` : undefined,
    `ACP adapter ${status.adapterVersion}`,
  ].filter((part): part is string => part !== undefined);
  lines.push(`**Runtime:** ${runtime.join(" · ")}`);
  return lines.join("\n");
}
