import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  section,
  compilePrompt,
  estimateTokens,
  estimatePromptTokens,
  COMMON_SECTIONS,
} from "../../src/core/prompt_compiler.js";

describe("prompt_compiler", () => {
  describe("section()", () => {
    it("creates a named section", () => {
      const s = section("role", "You are Athena.");
      assert.equal(s.name, "role");
      assert.equal(s.content, "You are Athena.");
    });

    it("trims content", () => {
      const s = section("x", "  hello  ");
      assert.equal(s.content, "hello");
    });
  });

  describe("compilePrompt()", () => {
    it("joins sections with double newline by default", () => {
      const result = compilePrompt([section("a", "A"), section("b", "B")]);
      assert.equal(result, "A\n\nB");
    });

    it("skips empty sections", () => {
      const result = compilePrompt([section("a", "A"), section("b", ""), section("c", "C")]);
      assert.equal(result, "A\n\nC");
    });

    it("includes headers when includeHeaders=true", () => {
      const result = compilePrompt([section("role", "You are X.")], { includeHeaders: true });
      assert.ok(result.startsWith("## role\nYou are X."));
    });

    it("respects token budget — truncates sections that exceed budget", () => {
      const longText = "x".repeat(400); // ~100 tokens
      const result = compilePrompt(
        [section("a", "short"), section("b", longText)],
        { tokenBudget: 10 }
      );
      assert.equal(result, "short");
    });

    it("keeps all sections when budget is sufficient", () => {
      const result = compilePrompt(
        [section("a", "hello"), section("b", "world")],
        { tokenBudget: 1000 }
      );
      assert.equal(result, "hello\n\nworld");
    });

    it("truncates section content when maxTokens is set on section", () => {
      const longContent = "a".repeat(200); // ~50 tokens worth
      const s = section("limited", longContent);
      s.maxTokens = 5; // cap at 5 tokens → ~20 chars
      const result = compilePrompt([s]);
      assert.ok(result.length < longContent.length, "should be truncated");
      assert.ok(result.includes("[...truncated to section budget]"));
    });

    it("does not truncate section when content is within maxTokens", () => {
      const s = section("ok", "short text");
      s.maxTokens = 100;
      const result = compilePrompt([s]);
      assert.equal(result, "short text");
    });
  });

  describe("estimateTokens()", () => {
    it("returns 0 for empty/null input", () => {
      assert.equal(estimateTokens(""), 0);
      assert.equal(estimateTokens(null), 0);
      assert.equal(estimateTokens(undefined), 0);
    });

    it("estimates ~1 token per 4 chars", () => {
      assert.equal(estimateTokens("abcd"), 1);
      assert.equal(estimateTokens("abcdefgh"), 2);
    });

    it("rounds up", () => {
      assert.equal(estimateTokens("ab"), 1); // ceil(2/4) = 1
    });
  });

  describe("estimatePromptTokens()", () => {
    it("returns total and per-section breakdown", () => {
      const sections = [section("a", "abcd"), section("b", "12345678")];
      const result = estimatePromptTokens(sections);
      assert.equal(result.total, 3); // 1 + 2
      assert.equal(result.sections.length, 2);
      assert.equal(result.sections[0].name, "a");
      assert.equal(result.sections[0].tokens, 1);
      assert.equal(result.sections[1].name, "b");
      assert.equal(result.sections[1].tokens, 2);
    });

    it("handles empty array", () => {
      const result = estimatePromptTokens([]);
      assert.equal(result.total, 0);
      assert.equal(result.sections.length, 0);
    });
  });

  describe("COMMON_SECTIONS", () => {
    it("has expected sections", () => {
      assert.ok(COMMON_SECTIONS.singlePromptMode);
      assert.ok(COMMON_SECTIONS.jsonOutputMarkers);
      assert.ok(COMMON_SECTIONS.noVagueGoals);
    });
  });
});
