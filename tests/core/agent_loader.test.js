import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentArgs } from "../../src/core/agent_loader.js";

describe("buildAgentArgs", () => {
  it("keeps existing leadership behavior by default", () => {
    // Leadership calls: no autopilot, no allow-all by default ÔÇö single-prompt mode
    const args = buildAgentArgs({
      agentSlug: "prometheus",
      prompt: "scan the repo",
      model: "GPT-5.3-Codex"
    });

    assert.ok(!args.includes("--autopilot"), "autopilot must be off by default");
    assert.ok(!args.includes("--max-autopilot-continues"), "max-autopilot-continues must be absent by default");
    assert.ok(args.includes("--agent"));
    assert.ok(args.includes("prometheus"));
  });

  it("supports a single-request agent call without autopilot", () => {
    const args = buildAgentArgs({
      agentSlug: "prometheus",
      prompt: "read the repo and produce one plan",
      model: "GPT-5.3-Codex",
      allowAll: true,
      autopilot: false,
      noAskUser: true,
      silent: true,
      maxContinues: 40
    });

    assert.ok(args.includes("--allow-all"));
    assert.ok(args.includes("--no-ask-user"));
    assert.ok(args.includes("--silent"));
    assert.ok(!args.includes("--autopilot"));
    assert.ok(!args.includes("--max-autopilot-continues"));
  });
});
