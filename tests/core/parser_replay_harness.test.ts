import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadCorpus, appendCorpusEntry, replayCorpus, MAX_CONFIDENCE_DELTA } from "../../src/core/parser_replay_harness.js";

describe("parser_replay_harness (Packet 10)", () => {
  describe("loadCorpus", () => {
    it("returns empty array for missing file", async () => {
      const corpus = await loadCorpus({ paths: { stateDir: "/nonexistent/path" } });
      assert.ok(Array.isArray(corpus));
      assert.equal(corpus.length, 0);
    });
  });

  describe("appendCorpusEntry", () => {
    it("is a callable function", () => {
      assert.equal(typeof appendCorpusEntry, "function");
    });
  });

  describe("MAX_CONFIDENCE_DELTA", () => {
    it("is a negative number", () => {
      assert.ok(MAX_CONFIDENCE_DELTA < 0);
    });
  });

  describe("replayCorpus", () => {
    it("returns empty results for empty corpus", () => {
      const result = replayCorpus([], () => ({ confidence: 0.5, plans: [] }));
      assert.ok(Array.isArray(result.results));
      assert.equal(result.results.length, 0);
      assert.equal(result.regressionCount, 0);
      assert.equal(result.passed, true);
    });

    it("detects regression when confidence drops significantly", () => {
      const corpus = [
        { id: "t1", raw: "test input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.5, plans: [] }));
      assert.ok(result.regressionCount > 0);
      assert.equal(result.passed, false);
    });

    it("passes when confidence is within threshold", () => {
      const corpus = [
        { id: "t1", raw: "test input", baselineConfidence: 0.8, expectedPlanCount: 1 },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.75, plans: [] }));
      assert.equal(result.regressionCount, 0);
      assert.equal(result.passed, true);
    });

    it("handles multiple corpus entries", () => {
      const corpus = [
        { id: "a", raw: "a", baselineConfidence: 0.9, expectedPlanCount: 1 },
        { id: "b", raw: "b", baselineConfidence: 0.7, expectedPlanCount: 1 },
        { id: "c", raw: "c", baselineConfidence: 0.5, expectedPlanCount: 0 },
      ];
      const result = replayCorpus(corpus, () => ({
        confidence: 0.6,
        plans: [],
      }));
      assert.equal(result.results.length, 3);
    });
  });
});
