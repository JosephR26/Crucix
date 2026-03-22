/**
 * Geo Cluster Detector — stub
 *
 * Future intent: detect geographic clustering of events across multiple sources
 * (e.g. simultaneous fire detections + conflict events + aircraft activity in
 * the same region within a single sweep window).
 *
 * Currently returns a placeholder insight to validate the pipeline end-to-end.
 */

import { makeInsight } from '../types.mjs';

const JOB_ID = 'geo-cluster-detector';

/** @type {import('../types.mjs').AnalysisJob} */
export const geoClusterJob = {
  id: JOB_ID,
  name: 'Geo Cluster Detector',
  description: 'Detects geographic co-location of signals from multiple sources (fires, conflict, air activity).',

  async run(ctx) {
    const insights = [];

    // Stub: count events with geo coordinates from normalized event stream
    const geoEvents = (ctx.events || []).filter(e => e.geo?.lat != null);

    if (geoEvents.length > 0) {
      insights.push(makeInsight(JOB_ID, {
        severity: 'info',
        title: `${geoEvents.length} geo-tagged events available for cluster analysis`,
        detail: 'Real clustering logic not yet implemented. Plug in your own algorithm here.',
        tags: ['geo', 'stub'],
        evidence: { geoEventCount: geoEvents.length },
      }));
    }

    return {
      jobId: JOB_ID,
      timestamp: new Date().toISOString(),
      insights,
      meta: { stub: true, eventCount: (ctx.events || []).length },
    };
  },
};
