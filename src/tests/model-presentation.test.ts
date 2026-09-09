import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { query, type ModelInfo, type Query } from "@anthropic-ai/claude-agent-sdk";
import { buildModelConfigOption, getAvailableModels } from "../session-model.js";

const OPUS: ModelInfo = {
  value: "opus[1m]",
  resolvedModel: "claude-opus-5[1m]",
  displayName: "Opus (1M context)",
  description: "Opus 5 with 1M context · Best for everyday, complex tasks",
};

describe("Opus display name", () => {
  beforeEach(() => vi.stubEnv("ANTHROPIC_MODEL", undefined));
  afterEach(() => vi.unstubAllEnvs());

  it("requires reviewing the live model contract whenever the SDK is upgraded", () => {
    const require = createRequire(import.meta.url);
    const sdkPackage = JSON.parse(
      readFileSync(
        join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"),
        "utf8",
      ),
    );
    expect(
      sdkPackage.version,
      "Run RUN_INTEGRATION_TESTS=true npx vitest run src/tests/model-presentation.test.ts " +
        "and review the Opus name normalization before updating this version guard.",
    ).toBe("0.3.257");
  });

  it("shortens only the known Opus label and preserves model identity and recommendation", async () => {
    const models: ModelInfo[] = [
      { ...OPUS, value: "default", displayName: "Default (recommended)" },
      OPUS,
      { value: "sonnet[1m]", displayName: "Sonnet 5 (1M context)", description: "" },
      { value: "custom", displayName: "Custom Opus (1M context)", description: "" },
    ];
    const setModel = vi.fn();
    const state = await getAvailableModels(
      { setModel } as unknown as Query,
      models,
      models,
      { getSettings: () => ({}) },
      { log: vi.fn(), error: vi.fn() },
      false,
      "model-presentation-test",
    );

    expect(state.availableModels).toEqual(
      models.map((model) => ({
        modelId: model.value,
        name: model === OPUS ? "Opus" : model.displayName,
        description: model.description,
      })),
    );
    expect(buildModelConfigOption(state, models, true)).toMatchObject({
      currentValue: "opus[1m]",
      _meta: { jetbrains: { air: { recommendedValue: "opus[1m]" } } },
      options: expect.arrayContaining([
        { value: "opus[1m]", name: "Opus", description: OPUS.description },
      ]),
    });
    expect(OPUS.displayName).toBe("Opus (1M context)");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("keeps the suffix if another selectable model is already named Opus", async () => {
    const models = [OPUS, { ...OPUS, value: "opus", displayName: "Opus" }];
    const state = await getAvailableModels(
      {} as Query,
      models,
      models,
      { getSettings: () => ({}) },
      { log: vi.fn(), error: vi.fn() },
      false,
      "model-presentation-test",
    );
    expect(state.availableModels.map((model) => model.name)).toEqual(["Opus (1M context)", "Opus"]);
  });
});

// Account-dependent model availability requires the same authenticated environment
// as the adapter. No prompt is sent: inspect only the SDK initialization response.
it.skipIf(!process.env.RUN_INTEGRATION_TESTS)(
  "the real SDK exposes one named Opus with the expected context suffix",
  async () => {
    let finishInput!: () => void;
    const inputGate = new Promise<void>((resolve) => {
      finishInput = resolve;
    });
    // Keep stdin open for initialization without ever submitting a prompt.
    // eslint-disable-next-line require-yield
    async function* input() {
      await inputGate;
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 25000);
    const q = query({ prompt: input(), options: { persistSession: false, abortController } });
    try {
      const { models } = await q.initializationResult();
      const opusModels = models.filter(
        (model) =>
          model.value !== "default" &&
          /\bopus\b/i.test(`${model.value} ${model.resolvedModel} ${model.displayName}`),
      );
      expect(opusModels).toHaveLength(1);
      expect(opusModels[0]).toMatchObject({
        value: "opus[1m]",
        displayName: "Opus (1M context)",
        resolvedModel: expect.stringMatching(/^claude-opus-.*\[1m\]$/),
        description: expect.stringContaining("1M context"),
      });
    } finally {
      clearTimeout(timeout);
      finishInput();
      q.close();
    }
  },
  30000,
);
