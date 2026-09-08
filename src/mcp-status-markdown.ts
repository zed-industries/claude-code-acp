import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";

const STATUS_PRESENTATION: Record<McpServerStatus["status"], { icon: string; label: string }> = {
  connected: { icon: "✅", label: "Connected" },
  pending: { icon: "⏳", label: "Connecting" },
  "needs-auth": { icon: "🔐", label: "Authentication required" },
  failed: { icon: "❌", label: "Failed" },
  disabled: { icon: "⏸️", label: "Disabled" },
};

const STATUS_ORDER: Record<McpServerStatus["status"], number> = {
  connected: 0,
  pending: 1,
  "needs-auth": 2,
  failed: 3,
  disabled: 4,
};

const MAX_VISIBLE_TOOLS = 12;

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
  for (const status of Object.keys(STATUS_PRESENTATION) as McpServerStatus["status"][]) {
    const count = counts.get(status);
    if (count) summary.push(`${count} ${STATUS_PRESENTATION[status].label.toLowerCase()}`);
  }

  const sections = sorted.map((server) => {
    const presentation = STATUS_PRESENTATION[server.status];
    const details = [`**Status:** ${presentation.label}`];
    if (server.scope) details.push(`**Scope:** ${inlineCode(server.scope)}`);
    if (server.serverInfo) {
      details.push(
        `**Server:** ${inlineCode(server.serverInfo.name)} ${inlineCode(server.serverInfo.version)}`,
      );
    }
    if (server.tools) {
      details.push(
        server.tools.length === 0
          ? "**Tools:** None"
          : `**Tools (${server.tools.length}):** ${formatTools(server.tools)}`,
      );
    }
    if (server.error) details.push(`**Error:** ${inlineCode(server.error)}`);

    return `### ${presentation.icon} ${inlineCode(server.name)}\n\n${details.join("  \n")}`;
  });

  return `## MCP servers\n\n${summary.join(" · ")}\n\n${sections.join("\n\n---\n\n")}`;
}
