import { describe, it, expect } from "vitest";
import { ClaudeAcpAgent } from "../acp-agent.js";

describe("loadSession capability", () => {
  it("advertises loadSession in initialize response", async () => {
    const agent = new ClaudeAcpAgent({} as any);
    const result = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });

    expect(result.agentCapabilities?.loadSession).toBe(true);
  });
});

