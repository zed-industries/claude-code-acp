import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { EffortLevel, ModelInfo, Settings } from "@anthropic-ai/claude-agent-sdk";
import { AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, withAirMeta } from "./air-extension.js";
import { EFFORT_CONFIG_ID } from "./session-config-ids.js";

export { EFFORT_CONFIG_ID } from "./session-config-ids.js";

// The SDK drops `undefined` during JSON transport and only clears a flag-layer
// setting when it receives an explicit `null`. Map both an absent picker and
// the legacy "default" row to null so a previously applied effort is cleared.
export function toSdkEffortLevel(value: string | undefined): EffortLevel | null {
  return value === undefined || value === "default" ? null : (value as EffortLevel);
}

/** Resolve the effort the CLI will use: per-model settings first, then the
 *  legacy top-level effort setting. Model settings are keyed by canonical
 *  model name, so try the resolved SDK model before picker and raw IDs. */
export function settingsEffortForModel(
  settings: Settings,
  modelInfo: ModelInfo | undefined,
  modelId?: string,
): string | undefined {
  const modelSettings = settings.modelSettings;
  if (modelSettings) {
    for (const key of [modelInfo?.resolvedModel, modelInfo?.value, modelId]) {
      const perModel = key !== undefined ? modelSettings[key]?.effortLevel : undefined;
      if (typeof perModel === "string") return perModel;
    }
  }
  return settings.effortLevel;
}

export function buildEffortConfigOption(
  modelInfos: ModelInfo[],
  currentModelId: string,
  currentEffortLevel: string | undefined,
  useRecommendedValue: boolean,
): SessionConfigOption | undefined {
  const currentModelInfo = modelInfos.find((model) => model.value === currentModelId);
  const supportedLevels = currentModelInfo?.supportsEffort
    ? (currentModelInfo.supportedEffortLevels ?? [])
    : [];
  if (supportedLevels.length === 0) return undefined;

  const recommendedEffort = (supportedLevels as string[]).includes("medium")
    ? "medium"
    : supportedLevels[0];
  const options = [
    ...(useRecommendedValue ? [] : [{ value: "default", name: "Default" }]),
    ...supportedLevels.map((level) => ({
      value: level,
      name: level
        .split(/[_-]/)
        .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
        .join(" "),
    })),
  ];
  const includes = (level: string) =>
    (!useRecommendedValue && level === "default") || (supportedLevels as string[]).includes(level);
  const currentValue =
    currentEffortLevel && includes(currentEffortLevel)
      ? currentEffortLevel
      : useRecommendedValue
        ? recommendedEffort
        : "default";

  return {
    id: EFFORT_CONFIG_ID,
    name: "Effort",
    description: "Available effort levels for this model",
    category: "thought_level",
    type: "select",
    currentValue,
    options,
    ...(useRecommendedValue
      ? {
          _meta: withAirMeta(undefined, AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, recommendedEffort),
        }
      : {}),
  };
}
