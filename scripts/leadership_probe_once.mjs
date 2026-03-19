#!/usr/bin/env node
import { loadConfig } from "../src/config.js";
import { runJesusSupervisorAnalysis } from "../src/core/jesus_supervisor.js";
import { runMosesCoordination } from "../src/core/moses_coordinator.js";

const config = await loadConfig();
const jesus = await runJesusSupervisorAnalysis(config);
const moses = await runMosesCoordination(config);

const out = {
  jesusSource: jesus?.decision?.source || null,
  jesusMode: jesus?.decision?.mode || null,
  jesusModel: jesus?.model || null,
  mosesSource: moses?.source || null,
  mosesModel: moses?.model || null,
  prompts: Array.isArray(moses?.plan?.taskPrompts) ? moses.plan.taskPrompts.length : 0,
  firstPromptRole: moses?.plan?.taskPrompts?.[0]?.role || null,
  firstPromptTitle: moses?.plan?.taskPrompts?.[0]?.taskTitle || null,
  firstPromptPreview: String(moses?.plan?.taskPrompts?.[0]?.prompt || "").slice(0, 260)
};

console.log(JSON.stringify(out, null, 2));
