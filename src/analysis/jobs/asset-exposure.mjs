/**
 * Asset Exposure Detector — stub
 *
 * Future intent: cross-reference CVEs/KEV entries (from CISA-KEV adapter)
 * against a user-defined asset inventory to flag assets exposed to actively
 * exploited vulnerabilities.
 *
 * Asset inventory can be provided via:
 *   config.analysis?.assetInventory — array of { id, ips, domains, asns, cves[] }
 *
 * Currently returns a placeholder insight summarising CVE exposure signals.
 */

import { makeInsight } from '../types.mjs';
import { EVENT_TYPES } from '../../adapters/SourceAdapter.mjs';

const JOB_ID = 'asset-exposure-detector';

/** @type {import('../types.mjs').AnalysisJob} */
export const assetExposureJob = {
  id: JOB_ID,
  name: 'Asset Exposure Detector',
  description: 'Flags assets in your inventory exposed to actively exploited CVEs from CISA-KEV.',

  async run(ctx) {
    const insights = [];

    // Collect exploited-vuln events from adapter-normalized stream
    const vulnEvents = (ctx.events || []).filter(e => e.type === EVENT_TYPES.VULN_EXPLOITED);

    if (vulnEvents.length === 0) {
      return { jobId: JOB_ID, timestamp: new Date().toISOString(), insights, meta: { stub: true } };
    }

    const criticalVulns = vulnEvents.filter(e => e.severity === 'critical');

    if (criticalVulns.length > 0) {
      insights.push(makeInsight(JOB_ID, {
        severity: 'alert',
        title: `${criticalVulns.length} ransomware-linked CVEs in current KEV sweep`,
        detail: 'Cross-reference against your asset inventory to identify exposed systems. Add your inventory to config.analysis.assetInventory to enable automated matching.',
        tags: ['cyber', 'cve', 'ransomware'],
        evidence: {
          cves: criticalVulns.map(e => e.id).slice(0, 10),
          totalVulnEvents: vulnEvents.length,
        },
      }));
    } else {
      insights.push(makeInsight(JOB_ID, {
        severity: 'info',
        title: `${vulnEvents.length} actively exploited CVEs in current sweep (no ransomware-linked)`,
        tags: ['cyber', 'cve'],
        evidence: { totalVulnEvents: vulnEvents.length },
      }));
    }

    return {
      jobId: JOB_ID,
      timestamp: new Date().toISOString(),
      insights,
      meta: { stub: true, vulnEventCount: vulnEvents.length },
    };
  },
};
