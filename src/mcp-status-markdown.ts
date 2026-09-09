import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";

const STATUS_LABELS: Record<McpServerStatus["status"], string> = {
  connected: "Connected",
  pending: "Connecting",
  "needs-auth": "Authentication required",
  failed: "Failed",
  disabled: "Disabled",
};

const STATUS_ORDER: Record<McpServerStatus["status"], number> = {
  failed: 0,
  "needs-auth": 1,
  pending: 2,
  connected: 3,
  disabled: 4,
};

const MAX_VISIBLE_TOOLS = 5;
const MAX_ERROR_LENGTH = 240;
const MCP_STATUS_TIMEOUT_MS = 5_000;

type McpStatusLogger = { error(...args: unknown[]): void };

export function isMcpStatusCommand(text: string): boolean {
  return text.trim() === "/mcp";
}

function inlineCode(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  let fence = "`";
  while (normalized.includes(fence)) fence += "`";
  const padding = normalized.startsWith("`") || normalized.endsWith("`") ? " " : "";
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatTools(tools: NonNullable<McpServerStatus["tools"]>): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const visible = sorted.slice(0, MAX_VISIBLE_TOOLS).map((tool) => inlineCode(tool.name));
  const remainder = sorted.length - visible.length;
  return `${visible.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
}

export function formatMcpStatusMarkdown(statuses: readonly McpServerStatus[]): string {
  if (statuses.length === 0) {
    return "## MCP servers\n\nNo MCP servers are configured for this session.";
  }

  const sorted = [...statuses].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
  );
  const counts = new Map<McpServerStatus["status"], number>();
  for (const server of sorted) counts.set(server.status, (counts.get(server.status) ?? 0) + 1);

  const summary = [plural(sorted.length, "server")];
  for (const status of Object.keys(STATUS_LABELS) as McpServerStatus["status"][]) {
    const count = counts.get(status);
    if (count) summary.push(`${count} ${STATUS_LABELS[status].toLowerCase()}`);
  }

  const rows = sorted.map((server) => {
    const details = [`**${STATUS_LABELS[server.status]}**`];
    if (server.scope) details.push(`scope ${inlineCode(server.scope)}`);
    if (server.serverInfo) {
      details.push(
        `server ${inlineCode(server.serverInfo.name)} ${inlineCode(server.serverInfo.version)}`,
      );
    }
    if (server.tools) {
      details.push(
        server.tools.length === 0
          ? "no tools"
          : `${plural(server.tools.length, "tool")}: ${formatTools(server.tools)}`,
      );
    }
    if (server.error) details.push(`error ${inlineCode(truncate(server.error, MAX_ERROR_LENGTH))}`);

    return `- ${inlineCode(server.name)} — ${details.join(" · ")}`;
  });

  return `## MCP servers\n\n${summary.join(" · ")}\n\n${rows.join("\n")}`;
}

/** Read MCP state through the SDK control lane while the owning slash-command
 * turn remains in the normal FIFO queue. Null means cancellation; failures are
 * rendered explicitly because the native terminal manager has no ACP UI. */
export async function fetchMcpStatusMarkdown(
  query: Query,
  signal: AbortSignal,
  logger: McpStatusLogger,
  hiddenServerNames: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  if (signal.aborted) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const statuses = await Promise.race([
      query.mcpServerStatus(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), MCP_STATUS_TIMEOUT_MS);
        timeout.unref?.();
      }),
      new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (statuses === null) {
      if (!signal.aborted) logger.error("MCP status request timed out");
      return signal.aborted
        ? null
        : "## MCP servers\n\nUnable to read MCP server status. Check the agent logs for details.";
    }
    return formatMcpStatusMarkdown(
      statuses.filter((server) => !hiddenServerNames.has(server.name)),
    );
  } catch (error) {
    logger.error(`Failed to inspect MCP servers: ${error}`);
    return "## MCP servers\n\nUnable to read MCP server status. Check the agent logs for details.";
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
