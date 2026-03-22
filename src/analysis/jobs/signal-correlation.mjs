/**
 * Signal Correlation — stub
 *
 * Future intent: correlate signals across domains — e.g. detect when a VIX
 * spike, a conflict escalation, and a Cloudflare outage all occur in the same
 * sweep window (multi-domain convergence pattern).
 *
 * Currently surfaces the delta summary as a structured insight so the
 * /api/analysis endpoint has useful data immediately.
 */

import { makeInsight } from '../types.mjs';

const JOB_ID = 'signal-correlation';

/** @type {import('../types.mjs').AnalysisJob} */
export const signalCorrelationJob = {
  id: JOB_ID,
  name: 'Signal Correlation',
  description: 'Detects convergence of risk signals across multiple domains in a single sweep window.',

  async run(ctx) {
    const insights = [];
    const delta = ctx.delta;

    if (!delta?.summary) {
      return { jobId: JOB_ID, timestamp: new Date().toISOString(), insights, meta: { stub: true, reason: 'no delta' } };
    }

    const { totalChanges, criticalChanges, direction } = delta.summary;

    // Surface delta as a structured insight — immediately useful for the UI panel
    if (totalChanges > 0) {
      const severity =
        criticalChanges >= 5 ? 'critical' :
        criticalChanges >= 2 ? 'alert' :
        totalChanges >= 5 ? 'warning' : 'info';

      insights.push(makeInsight(JOB_ID, {
        severity,
        title: `Delta: ${totalChanges} changes, ${criticalChanges} critical — direction: ${direction}`,
        detail: [
          `New signals: ${delta.summary.signalBreakdown.new}`,
          `Escalated: ${delta.summary.signalBreakdown.escalated}`,
          `De-escalated: ${delta.summary.signalBreakdown.deescalated}`,
          'Multi-domain convergence detection not yet implemented.',
        ].join('. '),
        tags: ['delta', 'correlation', direction],
        evidence: {
          direction,
          totalChanges,
          criticalChanges,
          signalBreakdown: delta.summary.signalBreakdown,
        },
      }));
    }

    // Stub convergence check: flag when both cyber and geopolitical signals are present
    const hasCyberSignal = delta.signals.new?.some(s => s.key?.startsWith('cisa') || s.key?.includes('kev'));
    const hasGeoSignal = delta.signals.escalated?.some(s => ['conflict_events', 'urgent_posts'].includes(s.key));

    if (hasCyberSignal && hasGeoSignal) {
      insights.push(makeInsight(JOB_ID, {
        severity: 'warning',
        title: 'Cross-domain convergence: cyber + geopolitical signals in same sweep',
        detail: 'Both new CVE/KEV entries and conflict/OSINT escalations detected simultaneously. This pattern warrants manual review.',
        tags: ['convergence', 'cyber', 'geo'],
      }));
    }

    return {
      jobId: JOB_ID,
      timestamp: new Date().toISOString(),
      insights,
      meta: { stub: true },
    };
  },
};
