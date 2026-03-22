// CISA KEV — Known Exploited Vulnerabilities Catalog
// No auth required. Tracks CVEs actively exploited in the wild.
// Federal agencies must patch these within due dates — useful signal
// for cybersecurity posture and active threat landscape.
//
// Implements SourceAdapter interface (src/adapters/SourceAdapter.mjs).
// Retains legacy `briefing()` export for backwards compatibility with
// apis/briefing.mjs orchestrator.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const SOURCE_NAME = 'CISA-KEV';

// ─── Internal helpers ────────────────────────────────────────────────────────

function summarizeVulnerabilities(vulns) {
  if (!vulns.length) return {};

  // Recent additions (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
  const recent = vulns.filter(v => {
    const added = new Date(v.dateAdded);
    return !isNaN(added) && added >= thirtyDaysAgo;
  });

  // Group by vendor
  const byVendor = {};
  for (const v of vulns) {
    const vendor = v.vendorProject || 'Unknown';
    byVendor[vendor] = (byVendor[vendor] || 0) + 1;
  }

  // Top vendors sorted by count
  const topVendors = Object.entries(byVendor)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([vendor, count]) => ({ vendor, count }));

  // Ransomware-linked
  const ransomwareLinked = vulns.filter(v => v.knownRansomwareCampaignUse === 'Known');

  // Overdue (due date has passed)
  const now = new Date();
  const overdue = vulns.filter(v => {
    const due = new Date(v.dueDate);
    return !isNaN(due) && due < now;
  });

  // Group recent by product for signal detection
  const recentByProduct = {};
  for (const v of recent) {
    const key = `${v.vendorProject} ${v.product}`;
    if (!recentByProduct[key]) recentByProduct[key] = [];
    recentByProduct[key].push(v);
  }

  const hotProducts = Object.entries(recentByProduct)
    .filter(([, vs]) => vs.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 10)
    .map(([product, vs]) => ({
      product,
      count: vs.length,
      cves: vs.map(v => v.cveID)
    }));

  return {
    totalInCatalog: vulns.length,
    recentAdditions: recent.length,
    ransomwareLinked: ransomwareLinked.length,
    overdueCount: overdue.length,
    topVendors,
    hotProducts,
  };
}

/**
 * Map raw CISA KEV vulnerability entries to NormalizedEvents.
 * Only maps recent entries (last 30 days) to avoid flooding the event list.
 */
function toEvents(recentEntries) {
  return recentEntries.map(v => makeEvent({
    id: v.cveID,
    type: EVENT_TYPES.VULN_EXPLOITED,
    timestamp: v.dateAdded ? new Date(v.dateAdded).toISOString() : new Date().toISOString(),
    title: `${v.cveID}: ${v.vulnerabilityName || v.product}`,
    description: (v.shortDescription || '').substring(0, 500),
    severity: v.knownRansomwareCampaignUse === 'Known' ? 'critical' : 'high',
    assets: {
      cves: [v.cveID],
    },
  }, SOURCE_NAME));
}

// ─── Core fetch logic (shared by adapter and legacy briefing) ────────────────

async function fetchKEV() {
  const data = await safeFetch(KEV_URL, { timeout: 20000 });

  if (data.error) {
    return {
      source: SOURCE_NAME,
      timestamp: new Date().toISOString(),
      error: data.error,
      events: [],
      summary: {},
      signals: [],
    };
  }

  const vulns = data.vulnerabilities || [];
  const catalogVersion = data.catalogVersion || null;
  const dateReleased = data.dateReleased || null;

  const summary = summarizeVulnerabilities(vulns);

  // Get the 20 most recently added
  const sorted = [...vulns]
    .sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));

  const recentEntries = sorted.slice(0, 20).map(v => ({
    cveID: v.cveID,
    vendorProject: v.vendorProject,
    product: v.product,
    vulnerabilityName: v.vulnerabilityName,
    dateAdded: v.dateAdded,
    dueDate: v.dueDate,
    shortDescription: (v.shortDescription || '').substring(0, 300),
    knownRansomwareCampaignUse: v.knownRansomwareCampaignUse,
  }));

  // Signals — actionable intelligence strings
  const signals = [];

  if (summary.recentAdditions > 5) {
    signals.push({
      severity: 'high',
      signal: `${summary.recentAdditions} new KEV entries in last 30 days — elevated exploit activity`,
    });
  }

  if (summary.hotProducts?.length > 0) {
    const top = summary.hotProducts[0];
    signals.push({
      severity: 'medium',
      signal: `${top.product} has ${top.count} actively exploited CVEs recently added`,
    });
  }

  const ransomwareRecent = recentEntries.filter(v => v.knownRansomwareCampaignUse === 'Known');
  if (ransomwareRecent.length > 0) {
    signals.push({
      severity: 'critical',
      signal: `${ransomwareRecent.length} recently added CVEs linked to ransomware campaigns`,
    });
  }

  return {
    source: SOURCE_NAME,
    timestamp: new Date().toISOString(),
    catalogVersion,
    dateReleased,
    summary,
    vulnerabilities: recentEntries,   // legacy field name kept for dashboard compat
    events: toEvents(recentEntries),  // normalized SourceAdapter events
    signals,
  };
}

// ─── SourceAdapter export ────────────────────────────────────────────────────

const cisaKevAdapter = createAdapter({
  name: SOURCE_NAME,
  tier: 6,
  requiresApiKey: false,

  /**
   * @param {import('../../src/adapters/SourceAdapter.mjs').SourceContext} ctx
   * @returns {Promise<import('../../src/adapters/SourceAdapter.mjs').SourceResult>}
   */
  async fetch(ctx) { // eslint-disable-line no-unused-vars
    const result = await fetchKEV();
    return {
      source: result.source,
      timestamp: result.timestamp,
      events: result.events || [],
      summary: result.summary || {},
      signals: (result.signals || []).map(s => s.signal),
      ...(result.error ? { error: result.error } : {}),
      // Preserve legacy fields for dashboard backwards compatibility
      catalogVersion: result.catalogVersion,
      dateReleased: result.dateReleased,
      vulnerabilities: result.vulnerabilities,
    };
  },
});

export default cisaKevAdapter;

// ─── Legacy briefing() export (keeps apis/briefing.mjs working as-is) ───────

export async function briefing() {
  return fetchKEV();
}

// Run standalone
if (process.argv[1]?.endsWith('cisa-kev.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
