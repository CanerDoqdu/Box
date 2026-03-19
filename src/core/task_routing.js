import fs from "node:fs/promises";

function normalizeTaskKind(kind) {
  return String(kind || "default").toLowerCase();
}

function renderTemplate(template, task) {
  return String(template)
    .replaceAll("{{TASK_TITLE}}", String(task?.title || ""))
    .replaceAll("{{TASK_KIND}}", String(task?.kind || "general"));
}

export async function resolveTaskRoute(config, task) {
  const routing = config?.copilot?.taskKindRouting || {};
  const kind = normalizeTaskKind(task?.kind);
  const selected = routing[kind] || routing.default || {
    agent: "box-coder",
    promptFile: ".github/prompts/box-plan-and-implement.prompt.md"
  };

  const promptPath = `${config.rootDir}/${selected.promptFile}`;
  let templateText = "";
  try {
    templateText = await fs.readFile(promptPath, "utf8");
  } catch {
    // falls back to the initial empty string — prompt file is optional
  }

  return {
    selectedAgent: selected.agent || "box-coder",
    promptFile: selected.promptFile,
    promptTemplateText: renderTemplate(templateText, task)
  };
}
