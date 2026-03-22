/**
 * Crucix Analysis Layer — public entry point
 *
 * Import this in server.mjs to get the registry and wire it into the sweep cycle.
 * Register your own jobs here or in separate files.
 *
 * Built-in stub jobs are registered on import so the /api/analysis endpoint
 * returns something meaningful out of the box.
 */

export { registry } from './registry.mjs';
export { makeInsight, ANALYSIS_JOB_VERSION } from './types.mjs';

// ─── Register built-in stub jobs ─────────────────────────────────────────────
// Real logic goes in src/analysis/jobs/*.mjs — these are scaffolds only.

import { registry } from './registry.mjs';
import { geoClusterJob } from './jobs/geo-cluster.mjs';
import { assetExposureJob } from './jobs/asset-exposure.mjs';
import { signalCorrelationJob } from './jobs/signal-correlation.mjs';

registry.register(geoClusterJob);
registry.register(assetExposureJob);
registry.register(signalCorrelationJob);
