/**
 * recurrence_detector.js — Detects recurring defect patterns in postmortems.
 *
 * Scans postmortem history for repeated failures with the same defect channel/tag
 * or lesson text, and promotes them to escalation if they recur above a threshold.
 *
 * Integration point: called by orchestrator after Athena postmortem, before next cycle.
 */

/** Minimum occurrences within the window to flag as recurring. */
export const RECURRENCE_THRESHOLD = 3;

/** Number of recent postmortems to scan. */
export const RECURRENCE_WINDOW = 20;

/**
 * @typedef {object} RecurrenceMatch
 * @property {string} pattern — description of the recurring pattern
 * @property {number} count — how many times it appeared in the window
 * @property {string} channel — "product" or "infra"
 * @property {string|null} tag — defect channel tag if available
 * @property {string} severity — "warning" | "critical"
 */

/**
 * Detect recurring defect patterns in postmortem history.
 *
 * @param {object[]} postmortems — full postmortem history array
 * @param {{ threshold?: number, window?: number }} opts
 * @returns {RecurrenceMatch[]}
 */
export function detectRecurrences(postmortems, opts = {}) {
  if (!Array.isArray(postmortems) || postmortems.length === 0) return [];

  const threshold = opts.threshold || RECURRENCE_THRESHOLD;
  const windowSize = opts.window || RECURRENCE_WINDOW;
  const recent = postmortems.slice(-windowSize);

  // Count by defectChannelTag (most specific)
  const tagCounts = new Map();
  // Count by lesson fingerprint (normalized first 80 chars)
  const lessonCounts = new Map();

  for (const pm of recent) {
    const tag = pm.defectChannelTag || pm.defectChannel || "unknown";
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);

    const lesson = String(pm.lessonLearned || "").toLowerCase().trim().slice(0, 80);
    if (lesson.length > 10) {
      lessonCounts.set(lesson, (lessonCounts.get(lesson) || 0) + 1);
    }
  }

  /** @type {RecurrenceMatch[]} */
  const matches = [];

  for (const [tag, count] of tagCounts) {
    if (count >= threshold) {
      const sample = recent.find(p => (p.defectChannelTag || p.defectChannel) === tag);
      matches.push({
        pattern: `Recurring defect tag: ${tag}`,
        count,
        channel: sample?.defectChannel || "unknown",
        tag,
        severity: count >= threshold * 2 ? "critical" : "warning"
      });
    }
  }

  for (const [lesson, count] of lessonCounts) {
    if (count >= threshold) {
      matches.push({
        pattern: `Recurring lesson: "${lesson.slice(0, 60)}..."`,
        count,
        channel: "product",
        tag: null,
        severity: count >= threshold * 2 ? "critical" : "warning"
      });
    }
  }

  return matches;
}

/**
 * Build escalation payloads from recurrence matches.
 *
 * @param {RecurrenceMatch[]} matches
 * @returns {object[]} — escalation-ready objects
 */
export function buildRecurrenceEscalations(matches) {
  return matches.map(m => ({
    source: "recurrence_detector",
    title: m.pattern,
    severity: m.severity,
    count: m.count,
    channel: m.channel,
    tag: m.tag,
    detectedAt: new Date().toISOString()
  }));
}
