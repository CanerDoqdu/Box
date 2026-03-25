import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerResponse } from "../../src/core/worker_runner.js";

describe("worker_runner safety seam", () => {
  it("forces blocked status when worker reports done but access protocol says blocked", () => {
    const output = [
      "Implemented the changes.",
      "BOX_STATUS=done",
      "BOX_ACCESS=repo:ok;files:ok;tools:blocked;api:ok"
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "blocked");
  });

  it("keeps done status when all access channels are ok", () => {
    const output = [
      "BOX_STATUS=done",
      "BOX_ACCESS=repo:ok;files:ok;tools:ok;api:ok",
      "BOX_PR_URL=https://github.com/org/repo/pull/9"
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "done");
  });

  it("keeps explicit blocked status intact", () => {
    const output = [
      "BOX_STATUS=blocked",
      "BOX_ACCESS=repo:blocked;files:ok;tools:ok;api:ok"
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "blocked");
  });
});
