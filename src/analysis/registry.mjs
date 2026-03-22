/**
 * Crucix Analysis Registry
 *
 * A lightweight registry for AnalysisJob modules. After each sweep + delta
 * computation, server.mjs calls `registry.runAll(ctx)` to execute all
 * registered jobs in parallel and collect their insights.
 *
 * Usage:
 *   import { registry } from './src/analysis/registry.mjs';
 *   import { myJob } from './src/analysis/jobs/my-job.mjs';
 *   registry.register(myJob);
 *
 * The registry is a singleton — one shared instance per process.
 */

import { ANALYSIS_JOB_VERSION } from './types.mjs';

class AnalysisRegistry {
  constructor() {
    /** @type {Map<string, import('./types.mjs').AnalysisJob>} */
    this._jobs = new Map();
    /** @type {import('./types.mjs').AnalysisResult[]} */
    this._lastResults = [];
  }

  /**
   * Register an analysis job.
   * Duplicate IDs are rejected — update the job in-place with `update()` instead.
   *
   * @param {import('./types.mjs').AnalysisJob} job
   */
  register(job) {
    if (!job.id || typeof job.run !== 'function') {
      throw new Error(`AnalysisRegistry: job must have an id and a run() function (got: ${JSON.stringify({ id: job.id })})`);
    }
    if (this._jobs.has(job.id)) {
      throw new Error(`AnalysisRegistry: job '${job.id}' is already registered. Use update() to replace it.`);
    }
    this._jobs.set(job.id, { enabled: true, ...job });
    console.log(`[Analysis] Registered job: ${job.id} — ${job.name || '(unnamed)'}`);
  }

  /**
   * Replace or add a job by ID (idempotent).
   *
   * @param {import('./types.mjs').AnalysisJob} job
   */
  update(job) {
    if (!job.id || typeof job.run !== 'function') {
      throw new Error(`AnalysisRegistry: job must have an id and a run() function`);
    }
    this._jobs.set(job.id, { enabled: true, ...job });
  }

  /**
   * Unregister a job by ID.
   *
   * @param {string} id
   */
  unregister(id) {
    this._jobs.delete(id);
  }

  /**
   * Enable or disable a job without unregistering it.
   *
   * @param {string} id
   * @param {boolean} enabled
   */
  setEnabled(id, enabled) {
    const job = this._jobs.get(id);
    if (job) job.enabled = enabled;
  }

  /**
   * Run all enabled jobs in parallel.
   * Individual job failures are caught and returned as error results rather than
   * propagating — a single broken job must not kill the sweep cycle.
   *
   * @param {import('./types.mjs').AnalysisContext} ctx
   * @returns {Promise<import('./types.mjs').AnalysisResult[]>}
   */
  async runAll(ctx) {
    const jobs = [...this._jobs.values()].filter(j => j.enabled !== false);
    if (jobs.length === 0) return [];

    const results = await Promise.allSettled(
      jobs.map(async job => {
        const start = Date.now();
        try {
          const result = await job.run(ctx);
          return {
            ...result,
            jobId: job.id,
            _durationMs: Date.now() - start,
          };
        } catch (err) {
          console.error(`[Analysis] Job '${job.id}' failed:`, err.message);
          return {
            jobId: job.id,
            timestamp: new Date().toISOString(),
            insights: [],
            _error: err.message,
            _durationMs: Date.now() - start,
          };
        }
      })
    );

    this._lastResults = results.map(r => r.status === 'fulfilled' ? r.value : {
      jobId: '?',
      timestamp: new Date().toISOString(),
      insights: [],
      _error: r.reason?.message,
    });

    return this._lastResults;
  }

  /**
   * Return the results from the most recent runAll() call.
   * Used by the /api/analysis endpoint to serve cached results without re-running.
   *
   * @returns {import('./types.mjs').AnalysisResult[]}
   */
  getLastResults() {
    return this._lastResults;
  }

  /**
   * Return a summary of all registered jobs (for /api/analysis metadata).
   */
  listJobs() {
    return [...this._jobs.values()].map(({ id, name, description, enabled }) => ({
      id,
      name: name || id,
      description: description || '',
      enabled: enabled !== false,
    }));
  }

  get version() {
    return ANALYSIS_JOB_VERSION;
  }
}

// Singleton
export const registry = new AnalysisRegistry();
