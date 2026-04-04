// FCDO TRAVEL — UK Foreign, Commonwealth & Development Office
// Real-time country risk levels for every nation on earth.
// Tracks: terrorism, civil unrest, entry requirements, natural disasters,
// health risks, and crime. Updated continuously by HMG analysts.
// No API key required. Official UK government JSON.
//
// Implements SourceAdapter interface. Retains legacy briefing() export.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'FCDO-TRAVEL';

// FCDO travel advice index — full list of countries with risk metadata
const FCDO_INDEX = 'https://www.gov.uk/api/content/foreign-travel-advice';

// Risk phrases that indicate elevated / critical situations
const HIGH_RISK_PHRASES = [
  'do not travel', 'advise against all travel', 'advise against all but essential',
  'active conflict', 'civil war', 'terrorist attacks', 'kidnapping', 'coup',
];
const CRITICAL_PHRASES = [
  'do not travel', 'advise against all travel', 'active conflict', 'civil war', 'coup',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractRiskLevel(parts) {
  // FCDO country pages have a 'summary' with the risk level in the first paragraph
  if (!Array.isArray(parts)) return 'unknown';
  for (const part of parts) {
    const text = (part?.body || part?.content || '').toLowerCase();
    if (CRITICAL_PHRASES.some(p => text.includes(p))) return 'critical';
    if (HIGH_RISK_PHRASES.some(p => text.includes(p))) return 'high';
  }
  return 'standard';
}

function severityFromRisk(risk) {
  if (risk === 'critical') return 'critical';
  if (risk === 'high')     return 'high';
  return 'low';
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchFCDO() {
  const index = await safeFetch(FCDO_INDEX, { timeout: 25000 });

  if (index.error) {
    return {
      source:    SOURCE_NAME,
      timestamp: new Date().toISOString(),
      error:     index.error,
      events:    [],
      summary:   {},
      signals:   [],
    };
  }

  // The FCDO content API returns a list of country links under links.children
  const children   = index?.links?.children || index?.links?.pages || [];
  const countries  = children.map(c => ({
    title:       c.title || '',
    slug:        (c.base_path || '').replace('/foreign-travel-advice/', '').replace('/', ''),
    url:         `https://www.gov.uk${c.base_path || ''}`,
    updated:     c.public_updated_at || null,
    description: (c.description || '').substring(0, 300),
  })).filter(c => c.title && c.slug);

  // Find recently updated countries (last 48h) — these signal active situation changes
  const cutoff = Date.now() - 48 * 3600_000;
  const recentlyUpdated = countries
    .filter(c => c.updated && new Date(c.updated) >= cutoff)
    .sort((a, b) => new Date(b.updated) - new Date(a.updated))
    .slice(0, 30);

  // For recently updated, check description for risk keywords
  const elevated = recentlyUpdated.map(c => {
    const text = c.description.toLowerCase();
    let risk = 'standard';
    if (CRITICAL_PHRASES.some(p => text.includes(p))) risk = 'critical';
    else if (HIGH_RISK_PHRASES.some(p => text.includes(p))) risk = 'high';
    return { ...c, risk };
  });

  const criticalCountries = elevated.filter(c => c.risk === 'critical');
  const highRiskCountries = elevated.filter(c => c.risk === 'high');

  // Signals
  const signals = [];

  if (criticalCountries.length > 0) {
    signals.push({
      severity: 'critical',
      signal:   `FCDO DO-NOT-TRAVEL updated (last 48 h): ${criticalCountries.map(c => c.title).join(', ')}`,
    });
  }
  if (highRiskCountries.length > 2) {
    signals.push({
      severity: 'high',
      signal:   `${highRiskCountries.length} countries with elevated FCDO travel risk updated in last 48 h`,
    });
  }
  if (recentlyUpdated.length > 10) {
    signals.push({
      severity: 'medium',
      signal:   `${recentlyUpdated.length} FCDO travel advisories updated in last 48 h — global instability signal`,
    });
  }

  // Events
  const events = criticalCountries.concat(highRiskCountries).slice(0, 20).map(c =>
    makeEvent({
      id:          `fcdo-${c.slug}-${c.updated}`,
      type:        EVENT_TYPES.CONFLICT_EVENT,
      timestamp:   c.updated ? new Date(c.updated).toISOString() : new Date().toISOString(),
      title:       `FCDO Advisory Updated: ${c.title}`.substring(0, 120),
      description: c.description.substring(0, 500),
      severity:    severityFromRisk(c.risk),
    }, SOURCE_NAME)
  );

  return {
    source:    SOURCE_NAME,
    timestamp: new Date().toISOString(),
    status:    'active',
    summary: {
      totalCountries:    countries.length,
      updatedLast48h:    recentlyUpdated.length,
      criticalAdvisories: criticalCountries.length,
      highRiskAdvisories: highRiskCountries.length,
    },
    recentlyUpdated:    elevated.slice(0, 30),
    criticalCountries,
    highRiskCountries,
    events,
    signals,
  };
}

// ─── SourceAdapter export ────────────────────────────────────────────────────

const fcdoAdapter = createAdapter({
  name:           SOURCE_NAME,
  tier:           2,
  requiresApiKey: false,

  async fetch(ctx) { // eslint-disable-line no-unused-vars
    const result = await fetchFCDO();
    return {
      source:            result.source,
      timestamp:         result.timestamp,
      events:            result.events || [],
      summary:           result.summary || {},
      signals:           (result.signals || []).map(s => s.signal),
      recentlyUpdated:   result.recentlyUpdated,
      criticalCountries: result.criticalCountries,
      highRiskCountries: result.highRiskCountries,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export default fcdoAdapter;

// ─── Legacy briefing() ───────────────────────────────────────────────────────

export async function briefing() {
  return fetchFCDO();
}

if (process.argv[1]?.endsWith('fcdo-travel.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
