/**
 * lesson_halflife.js — Time-decayed relevance scoring for postmortem lessons.
 *
 * Older lessons naturally lose relevance as the codebase evolves.
 * This module computes a relevance weight for each lesson based on its age,
 * so that Athena can prioritize recent learnings over stale ones.
 *
 * Formula: weight = 2^(-ageInDays / halfLifeDays)
 *   - age = 0     → weight = 1.0
 *   - age = half   → weight = 0.5
 *   - age = 2×half → weight = 0.25
 */

/** Default half-life in days. */
export const DEFAULT_HALF_LIFE_DAYS = 14;

/**
 * Compute the relevance weight of a lesson.
 *
 * @param {string|Date} reviewedAt — ISO timestamp of when the lesson was recorded
 * @param {{ halfLifeDays?: number, now?: number }} opts
 * @returns {number} weight in [0, 1]
 */
export function computeLessonWeight(reviewedAt, opts: any = {}) {
  if (!reviewedAt) return 0;

  const halfLife = opts.halfLifeDays || DEFAULT_HALF_LIFE_DAYS;
  const now = opts.now || Date.now();
  const ageMs = now - new Date(reviewedAt).getTime();
  if (ageMs <= 0) return 1.0;

  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.pow(2, -ageDays / halfLife);
}

/**
 * Rank postmortem lessons by time-decayed relevance.
 * Returns the top N lessons sorted by weight descending.
 *
 * @param {object[]} postmortems
 * @param {{ halfLifeDays?: number, now?: number, limit?: number }} opts
 * @returns {{ lesson: string, weight: number, reviewedAt: string }[]}
 */
export function rankLessonsByRelevance(postmortems, opts: any = {}) {
  if (!Array.isArray(postmortems)) return [];

  const limit = opts.limit || 10;
  const scored = [];

  for (const pm of postmortems) {
    const lesson = pm?.lessonLearned;
    if (!lesson || String(lesson).trim().length < 5) continue;

    const weight = computeLessonWeight(pm.reviewedAt, opts);
    scored.push({
      lesson: String(lesson).trim(),
      weight: Math.round(weight * 1000) / 1000,
      reviewedAt: pm.reviewedAt || ""
    });
  }

  scored.sort((a, b) => b.weight - a.weight);
  return scored.slice(0, limit);
}
