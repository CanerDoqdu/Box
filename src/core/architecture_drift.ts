import fs from "node:fs/promises";
import path from "node:path";

// Only match backtick-quoted paths that start with known repo-local prefixes.
// This prevents false positives from absolute paths or environment-specific paths.
// Handles:
//   - Standard extension files: src/core/orchestrator.ts
//   - .Dockerfile extension:    docker/worker.Dockerfile
//   - Bare Dockerfile filename: docker/worker/Dockerfile
const REPO_LOCAL_PATH_RE =
  /`((?:src|tests|docker|scripts|\.github)\/(?:[^`\s,)/]*\/)*(?:[^`\s,)]+\.(?:ts|js|cjs|mjs|json|yml|yaml|md|ps1|sh|Dockerfile)|Dockerfile))`/g;

const DOC_EXTENSIONS = new Set([".md"]);

export interface StaleRef {
  docPath: string;
  referencedPath: string;
  line: number;
}

export interface ArchitectureDriftReport {
  scannedDocs: string[];
  presentCount: number;
  staleCount: number;
  staleReferences: StaleRef[];
}

async function listDocFiles(rootDir: string, docDirs: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const docDir of docDirs) {
    const absDir = path.join(rootDir, docDir);
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(`${docDir}/${entry.name}`);
      }
    }
  }
  return results;
}

function extractRepoLocalPaths(content: string): Array<{ referencedPath: string; line: number }> {
  const refs: Array<{ referencedPath: string; line: number }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const re = new RegExp(REPO_LOCAL_PATH_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(lines[i])) !== null) {
      refs.push({ referencedPath: match[1], line: i + 1 });
    }
  }
  return refs;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function checkArchitectureDrift(options: {
  rootDir: string;
  docDirs?: string[];
}): Promise<ArchitectureDriftReport> {
  const { rootDir, docDirs = ["docs"] } = options;

  const docFiles = await listDocFiles(rootDir, docDirs);
  const staleReferences: StaleRef[] = [];
  let presentCount = 0;
  const seen = new Set<string>();

  for (const docRelPath of docFiles) {
    const absDocPath = path.join(rootDir, docRelPath);
    let content: string;
    try {
      content = await fs.readFile(absDocPath, "utf8");
    } catch {
      continue;
    }

    const refs = extractRepoLocalPaths(content);
    for (const { referencedPath, line } of refs) {
      // De-duplicate: only check each unique path once per doc
      const key = `${docRelPath}::${referencedPath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const absRef = path.join(rootDir, referencedPath);
      if (await fileExists(absRef)) {
        presentCount++;
      } else {
        staleReferences.push({ docPath: docRelPath, referencedPath, line });
      }
    }
  }

  return {
    scannedDocs: docFiles,
    presentCount,
    staleCount: staleReferences.length,
    staleReferences
  };
}
