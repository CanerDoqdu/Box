import { writeJsonAtomic } from "./fs_utils.js";

export async function writeCheckpoint(config, checkpoint) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = `${config.paths.stateDir}/checkpoint-${stamp}.json`;
  await writeJsonAtomic(filePath, checkpoint);
  return filePath;
}
