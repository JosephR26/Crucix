/**
 * Crucix Analysis Layer — Type definitions
 *
 * An AnalysisJob receives the most recent delta + event list and produces
 * derived insights. Jobs are stateless — they read from the input and return
 * results; persistence is handled by the registry runner.
 *
 * Design intent: keep this layer completely decoupled from sweep internals.
 * Jobs only see normalized data and deltas; they don't import source modules.
 */

// ─── Types (JSDoc) ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} AnalysisContext
 * @property {Object}   currentData     - Full synthesized sweep object (from inject.mjs)
 * @property {Object|null} delta        - Delta from lib/delta/engine.mjs (null on first run)
 * @property {import('../adapters/SourceAdapter.mjs').NormalizedEvent[]} events
 *                                      - All normalized events from adapters that implement
 *                                        the SourceAdapter interface (grows over time as
 *                                        more sources are refactored)
 * @property {Object}   config          - Full crucix config object
 * @property {Object[]} history         - Last N run snapshots from MemoryManager
 */

/**
 * @typedef {'info'|'warning'|'alert'|'critical'} InsightSeverity
 */

/**
 * @typedef {Object} Insight
 * @property {string}          jobId       - ID of the analysis job that produced this
 * @property {string}          id          - Stable unique ID for this insight instance
 * @property {InsightSeverity} severity    - Severity level
 * @property {string}          title       - Short human-readable title (< 100 chars)
 * @property {string}          [detail]    - Longer explanation (< 1000 chars)
 * @property {string}          timestamp   - ISO timestamp when the insight was generated
 * @property {Object}          [evidence]  - Supporting data (source events, metric values, etc.)
 * @property {string[]}        [tags]      - Free-form tags for filtering (e.g. 'cyber', 'geo', 'economic')
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {string}    jobId      - Must match AnalysisJob.id
 * @property {string}    timestamp  - ISO timestamp of this run
 * @property {Insight[]} insights   - Zero or more insights produced by this job
 * @property {Object}    [meta]     - Optional debug/performance metadata
 */

/**
 * @typedef {Object} AnalysisJob
 * @property {string}   id          - Unique identifier, kebab-case (e.g. 'asset-exposure-detector')
 * @property {string}   name        - Human-readable display name
 * @property {string}   description - What this job detects/correlates
 * @property {boolean}  [enabled]   - Defaults to true; set false to skip without unregistering
 * @property {function(AnalysisContext): Promise<AnalysisResult>} run
 *                                  - The analysis function
 */

// Export a runtime sentinel so callers can validate at import time
export const ANALYSIS_JOB_VERSION = '1.0';

/**
 * Create an Insight with required fields filled in.
 *
 * @param {string} jobId
 * @param {Partial<Insight>} fields
 * @returns {Insight}
 */
export function makeInsight(jobId, fields) {
  return {
    jobId,
    id: fields.id || `${jobId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    severity: fields.severity || 'info',
    title: fields.title || '(no title)',
    timestamp: fields.timestamp || new Date().toISOString(),
    ...fields,
  };
}
