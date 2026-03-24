import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyComplexityTier,
  COMPLEXITY_TIER,
  isModelBanned,
  isOpusTier,
  isOpusJustified,
  ROUTING_REASON,
  enforceModelPolicy,
  routeModelByComplexity,
} from "../../src/core/model_policy.js";

describe("model_policy — complexity tiers", () => {
  describe("classifyComplexityTier", () => {
    it("returns T1 for simple tasks", () => {
      const result = classifyComplexityTier({ estimatedLines: 50, complexity: "low" });
      assert.equal(result.tier, COMPLEXITY_TIER.T1);
      assert.equal(result.maxContinuations, 1);
    });

    it("returns T2 for medium tasks", () => {
      const result = classifyComplexityTier({ estimatedLines: 800, complexity: "medium" });
      assert.equal(result.tier, COMPLEXITY_TIER.T2);
      assert.equal(result.maxContinuations, 3);
    });

    it("returns T3 for critical tasks", () => {
      const result = classifyComplexityTier({ complexity: "critical" });
      assert.equal(result.tier, COMPLEXITY_TIER.T3);
      assert.equal(result.maxContinuations, 5);
    });

    it("returns T3 for high line count", () => {
      const result = classifyComplexityTier({ estimatedLines: 5000 });
      assert.equal(result.tier, COMPLEXITY_TIER.T3);
    });

    it("returns T3 for long duration", () => {
      const result = classifyComplexityTier({ estimatedDurationMinutes: 180 });
      assert.equal(result.tier, COMPLEXITY_TIER.T3);
    });

    it("returns T2 for medium complexity keyword", () => {
      const result = classifyComplexityTier({ complexity: "medium" });
      assert.equal(result.tier, COMPLEXITY_TIER.T2);
    });

    it("returns T1 for empty hints", () => {
      const result = classifyComplexityTier({});
      assert.equal(result.tier, COMPLEXITY_TIER.T1);
    });

    it("includes reason string", () => {
      const result = classifyComplexityTier({ complexity: "high" });
      assert.ok(result.reason.includes("complexity=high"));
    });
  });

  describe("COMPLEXITY_TIER enum", () => {
    it("has three tiers", () => {
      assert.equal(Object.keys(COMPLEXITY_TIER).length, 3);
      assert.ok(COMPLEXITY_TIER.T1);
      assert.ok(COMPLEXITY_TIER.T2);
      assert.ok(COMPLEXITY_TIER.T3);
    });

    it("is frozen", () => {
      assert.ok(Object.isFrozen(COMPLEXITY_TIER));
    });
  });

  describe("existing model_policy exports", () => {
    it("bans fast models", () => {
      const result = isModelBanned("Claude Opus 4.6 Fast");
      assert.equal(result.banned, true);
    });

    it("detects opus tier", () => {
      assert.equal(isOpusTier("Claude Opus 4.6"), true);
      assert.equal(isOpusTier("Claude Sonnet 4.6"), false);
    });

    it("justifies opus for critical tasks", () => {
      const result = isOpusJustified({ complexity: "critical" });
      assert.equal(result.allowed, true);
    });

    it("rejects opus for small tasks", () => {
      const result = isOpusJustified({ estimatedLines: 10 });
      assert.equal(result.allowed, false);
    });

    it("enforceModelPolicy bans fast models", () => {
      const result = enforceModelPolicy("Claude Fast Preview");
      assert.equal(result.downgraded, true);
      assert.equal(result.routingReasonCode, ROUTING_REASON.BANNED);
    });

    it("enforceModelPolicy allows normal models", () => {
      const result = enforceModelPolicy("Claude Sonnet 4.6");
      assert.equal(result.downgraded, false);
      assert.equal(result.routingReasonCode, ROUTING_REASON.ALLOWED);
    });
  });

  describe("routeModelByComplexity", () => {
    it("routes T3 tasks to strong model", () => {
      const result = routeModelByComplexity({ complexity: "critical" }, { strongModel: "Claude Opus 4.6" });
      assert.equal(result.model, "Claude Opus 4.6");
      assert.equal(result.tier, COMPLEXITY_TIER.T3);
    });

    it("routes T1 tasks to efficient model", () => {
      const result = routeModelByComplexity({ estimatedLines: 10 }, { efficientModel: "Claude Haiku 4" });
      assert.equal(result.model, "Claude Haiku 4");
      assert.equal(result.tier, COMPLEXITY_TIER.T1);
    });

    it("routes T2 tasks to default model", () => {
      const result = routeModelByComplexity({ complexity: "medium" }, { defaultModel: "Claude Sonnet 4.6" });
      assert.equal(result.model, "Claude Sonnet 4.6");
      assert.equal(result.tier, COMPLEXITY_TIER.T2);
    });

    it("uses Claude Sonnet 4.6 as default when no options", () => {
      const result = routeModelByComplexity({});
      assert.equal(result.model, "Claude Sonnet 4.6");
    });
  });
});
