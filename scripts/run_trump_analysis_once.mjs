import { loadConfig } from "../src/config.js";
import { runTrumpAnalysis } from "../src/core/trump.js";

const config = await loadConfig();
const reason = process.argv.slice(2).join(" ") || "Manual one-shot Trump analysis run.";
const plan = await runTrumpAnalysis(config, { trumpReason: reason });

if (!plan) {
  console.error("NO_PLAN");
  process.exit(1);
}

console.log("PLAN_OK");
console.log(`HEALTH=${plan.projectHealth || "unknown"}`);
console.log(`DOSSIER=${plan.dossierPath || "state/trump_dossier.md"}`);
