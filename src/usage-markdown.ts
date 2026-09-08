import type { Query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const STRUCTURED_USAGE_TIMEOUT_MS = 5_000;

type UsageLogger = { error(...args: unknown[]): void };

const countSchema = z.number().finite().nonnegative();
const percentSchema = countSchema.max(100);
const usageWindowSchema = z
  .object({ utilization: percentSchema.nullable(), resets_at: z.string().nullable() })
  .nullable()
  .optional();
const contributionSchema = z.object({ name: z.string(), pct: percentSchema });
const behaviorPeriodSchema = z.object({
  request_count: countSchema,
  session_count: countSchema,
  mcp_servers: z.array(contributionSchema),
});
const modelUsageSchema = z.object({
  inputTokens: countSchema,
  outputTokens: countSchema,
  cacheReadInputTokens: countSchema,
  cacheCreationInputTokens: countSchema,
});

const usageResponseSchema = z.object({
  session: z.object({
    total_cost_usd: countSchema,
    total_api_duration_ms: countSchema,
    total_duration_ms: countSchema,
    model_usage: z.record(z.string(), modelUsageSchema),
  }),
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: usageWindowSchema,
      seven_day: usageWindowSchema,
      seven_day_oauth_apps: usageWindowSchema,
      seven_day_opus: usageWindowSchema,
      seven_day_sonnet: usageWindowSchema,
      model_scoped: z
        .array(
          z.object({
            display_name: z.string(),
            utilization: percentSchema.nullable(),
            resets_at: z.string().nullable(),
          }),
        )
        .optional(),
      extra_usage: z
        .object({
          is_enabled: z.boolean(),
          monthly_limit: countSchema.nullable(),
          used_credits: countSchema.nullable(),
          utilization: percentSchema.nullable(),
          currency: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  behaviors: z.object({ day: behaviorPeriodSchema, week: behaviorPeriodSchema }).nullable(),
});

/** Validate the experimental SDK response at the runtime boundary. */
export function parseUsageResponse(value: unknown): SDKControlGetUsageResponse | null {
  const parsed = usageResponseSchema.safeParse(value);
  // Validate only the fields the renderer reads, but preserve the complete
  // response. The experimental API may add values to unused subtrees without
  // making the useful, already-validated portion unsafe to render.
  return parsed.success ? (value as SDKControlGetUsageResponse) : null;
}

export function isUsageCommandText(text: string): boolean {
  return ["/usage", "/cost", "/stats"].includes(text.trim());
}

/** Read and validate the SDK's experimental structured usage response without
 * allowing the control request to hold a local command indefinitely. */
export async function fetchStructuredUsage(
  query: Query,
  signal: AbortSignal,
  logger: UsageLogger,
): Promise<SDKControlGetUsageResponse | null> {
  if (signal.aborted) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const response = await Promise.race([
      query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), STRUCTURED_USAGE_TIMEOUT_MS);
        timeout.unref?.();
      }),
      new Promise<null>((resolve) => {
        onAbort = () => resolve(null);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
    if (response === null) {
      if (!signal.aborted) logger.error("Structured usage timed out");
      return null;
    }
    const usage = parseUsageResponse(response);
    if (!usage) logger.error("Structured usage returned an incompatible response");
    return usage;
  } catch (error) {
    logger.error(`Structured usage failed: ${error}`);
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Best-effort structured presentation for the local `/usage` turn. */
export async function fetchStructuredUsageMarkdown(
  query: Query,
  signal: AbortSignal,
  logger: UsageLogger,
): Promise<string | null> {
  const usage = await fetchStructuredUsage(query, signal, logger);
  return usage ? formatUsageResponse(usage) : null;
}

export function usageBar(percent: number): string {
  const cells = 20;
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * cells));
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>|])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatReset(value: string | null): string {
  if (!value) return "";
  const reset = new Date(value);
  if (Number.isNaN(reset.getTime())) return ` · Resets ${escapeMarkdown(value)}`;
  return ` · Resets ${new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(reset)}`;
}

type UsageLimitProgress = {
  label: string;
  utilization: number;
  resetsAt: string | null;
};

/** Every quota window exposed by structured usage, in display order. */
function usageLimitProgress(usage: SDKControlGetUsageResponse): UsageLimitProgress[] {
  if (!usage.rate_limits_available || !usage.rate_limits) return [];
  const limits = usage.rate_limits;
  const rows: UsageLimitProgress[] = [];
  const add = (
    label: string,
    window: { utilization: number | null; resets_at: string | null } | null | undefined,
  ) => {
    if (window?.utilization === null || window?.utilization === undefined) return;
    rows.push({ label, utilization: window.utilization, resetsAt: window.resets_at });
  };

  add("5-hour limit", limits.five_hour);
  add("Weekly · all models", limits.seven_day);
  add("Weekly · OAuth apps", limits.seven_day_oauth_apps);
  const modelWindows = limits.model_scoped ?? [];
  for (const model of modelWindows) add(`Weekly · ${model.display_name}`, model);
  if (modelWindows.length === 0) {
    add("Weekly · Opus", limits.seven_day_opus);
    add("Weekly · Sonnet", limits.seven_day_sonnet);
  }
  const extra = limits.extra_usage;
  if (extra?.is_enabled && extra.utilization !== null) {
    const amount =
      extra.used_credits !== null && extra.monthly_limit !== null
        ? ` · ${formatCount(extra.used_credits)} / ${formatCount(extra.monthly_limit)}${extra.currency ? ` ${extra.currency}` : ""}`
        : "";
    rows.push({
      label: `Extra usage${amount}`,
      utilization: extra.utilization,
      resetsAt: null,
    });
  }
  return rows;
}

function appendLimit(lines: string[], limit: UsageLimitProgress): void {
  lines.push(
    `**${escapeMarkdown(limit.label)}** — **${limit.utilization}%**${formatReset(limit.resetsAt)}`,
    "",
    `\`${usageBar(limit.utilization)}\``,
    "",
  );
}

function appendContributions(
  lines: string[],
  label: string,
  period: {
    request_count: number;
    session_count: number;
    mcp_servers: { name: string; pct: number }[];
  },
): void {
  lines.push(
    "",
    `**${label}** · ${period.request_count} requests · ${period.session_count} sessions`,
  );
  if (period.mcp_servers.length === 0) return;
  lines.push("", "| MCP server | Usage |", "|:--|--:|");
  for (const server of [...period.mcp_servers].sort((a, b) => b.pct - a.pct).slice(0, 3)) {
    lines.push(`| ${escapeMarkdown(server.name)} | \`${usageBar(server.pct)}\` ${server.pct}% |`);
  }
}

/** Render the SDK's structured `/usage` response as Markdown. */
export function formatUsageResponse(usage: SDKControlGetUsageResponse): string {
  const lines = ["## Usage"];
  if (usage.subscription_type) {
    lines.push("", `> Claude ${escapeMarkdown(usage.subscription_type)} subscription usage`);
  }

  if (usage.rate_limits_available && usage.rate_limits) {
    const limitLines: string[] = [];
    for (const limit of usageLimitProgress(usage)) appendLimit(limitLines, limit);
    if (limitLines.length > 0) {
      if (limitLines.at(-1) === "") limitLines.pop();
      lines.push("", "### Limits", "", ...limitLines);
    }
  }

  const models = Object.values(usage.session.model_usage);
  const totals = models.reduce(
    (sum, model) => ({
      input: sum.input + model.inputTokens,
      output: sum.output + model.outputTokens,
      cacheRead: sum.cacheRead + model.cacheReadInputTokens,
      cacheWrite: sum.cacheWrite + model.cacheCreationInputTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  lines.push(
    "",
    "---",
    "",
    "### This session",
    "",
    "| Cost | API time | Active |",
    "|:--|:--|:--|",
    `| $${usage.session.total_cost_usd.toFixed(2)} | ${formatDuration(usage.session.total_api_duration_ms)} | ${formatDuration(usage.session.total_duration_ms)} |`,
    "",
    "| Breakdown | Tokens |",
    "|:--|--:|",
    `| Input | ${formatCount(totals.input)} |`,
    `| Output | ${formatCount(totals.output)} |`,
    `| Cache read | ${formatCount(totals.cacheRead)} |`,
    `| Cache write | ${formatCount(totals.cacheWrite)} |`,
  );

  if (usage.behaviors) {
    lines.push(
      "",
      "---",
      "",
      "### What’s using your limits?",
      "",
      "> Approximate, overlapping measures · this machine only · excludes claude.ai",
    );
    appendContributions(lines, "Last 24h", usage.behaviors.day);
    appendContributions(lines, "Last 7d", usage.behaviors.week);
  }
  return lines.join("\n");
}
