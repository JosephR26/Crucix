// NCSC — UK National Cyber Security Centre
// Official HMG threat intelligence. Covers active threat actor campaigns,
// vulnerability advisories, sector-specific alerts, and TTP disclosures.
// No API key required. RSS + JSON feeds, updated daily.
//
// Implements SourceAdapter interface (src/adapters/SourceAdapter.mjs).
// Retains legacy `briefing()` export for backwards compatibility.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'NCSC-UK';

// ─── Feed endpoints ──────────────────────────────────────────────────────────

const FEEDS = {
  alerts:    'https://www.ncsc.gov.uk/api/1/services/news/alerts-and-advisories/rss-feed.xml',
  guidance:  'https://www.ncsc.gov.uk/api/1/services/news/guidance-and-standards/rss-feed.xml',
  news:      'https://www.ncsc.gov.uk/api/1/services/news/ncsc-news/rss-feed.xml',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseRSSItems(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const items = [];
  const itemBlocks = rawText.match(/<item[^>]*>([\/\S\s]*?)<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i'));
      return (m?.[1] ?? m?.[2] ?? '').trim();
    };
    const title = get('title');
    const link  = get('link');
    const date  = get('pubDate') || get('dc:date');
    const desc  = get('description').replace(/<[^>]+>/g, '').trim();
    if (title) items.push({ title, link, date, description: desc.substring(0, 400) });
  }
  return items;
}

function severityFromTitle(title) {
  const t = title.toLowerCase();
  if (t.includes('critical') || t.includes('emergency') || t.includes('nation-state')) return 'critical';
  if (t.includes('high') || t.includes('actively exploited') || t.includes('ransomware')) return 'high';
  if (t.includes('medium') || t.includes('advisory') || t.includes('warning')) return 'medium';
  return 'low';
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchNCSC() {
  const [alertsRes, guidanceRes, newsRes] = await Promise.all([
    safeFetch(FEEDS.alerts,   { timeout: 20000 }),
    safeFetch(FEEDS.guidance, { timeout: 20000 }),
    safeFetch(FEEDS.news,     { timeout: 20000 }),
  ]);

  const alertItems    = parseRSSItems(alertsRes?.rawText   || '');
  const guidanceItems = parseRSSItems(guidanceRes?.rawText || '');
  const newsItems     = parseRSSItems(newsRes?.rawText     || '');

  // Combine and deduplicate by link
  const seen = new Set();
  const all = [...alertItems, ...guidanceItems, ...newsItems].filter(i => {
    if (!i.link || seen.has(i.link)) return false;
    seen.add(i.link);
    return true;
  });

  // Sort by date desc, take 30
  const sorted = all
    .filter(i => i.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 30);

  // Signals — items published in the last 72 h are hot
  const cutoff = Date.now() - 72 * 3600_000;
  const fresh  = sorted.filter(i => new Date(i.date) >= cutoff);
  const signals = [];

  if (fresh.length > 0) {
    signals.push({ severity: 'high', signal: `${fresh.length} NCSC alert(s) issued in the last 72 h — review immediately` });
  }

  const criticals = fresh.filter(i => severityFromTitle(i.title) === 'critical');
  if (criticals.length > 0) {
    signals.push({ severity: 'critical', signal: `NCSC CRITICAL advisory: "${criticals[0].title}"` });
  }

  const events = sorted.map(i => makeEvent({
    id:          i.link || `${SOURCE_NAME}-${i.title.slice(0, 40)}`,
    type:        EVENT_TYPES.VULN_EXPLOITED,
    timestamp:   i.date ? new Date(i.date).toISOString() : new Date().toISOString(),
    title:       i.title.substring(0, 120),
    description: i.description,
    severity:    severityFromTitle(i.title),
    assets:      { domains: ['ncsc.gov.uk'] },
  }, SOURCE_NAME));

  return {
    source:    SOURCE_NAME,
    timestamp: new Date().toISOString(),
    status:    'active',
    summary: {
      total:        sorted.length,
      freshAlerts:  fresh.length,
      critical:     criticals.length,
      categories: {
        alerts:   alertItems.length,
        guidance: guidanceItems.length,
        news:     newsItems.length,
      },
    },
    items:   sorted,
    events,
    signals,
  };
}

// ─── SourceAdapter export ────────────────────────────────────────────────────

const ncscAdapter = createAdapter({
  name:           SOURCE_NAME,
  tier:           2,
  requiresApiKey: false,

  async fetch(ctx) { // eslint-disable-line no-unused-vars
    const result = await fetchNCSC();
    return {
      source:    result.source,
      timestamp: result.timestamp,
      events:    result.events || [],
      summary:   result.summary || {},
      signals:   (result.signals || []).map(s => s.signal),
      items:     result.items,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export default ncscAdapter;

// ─── Legacy briefing() ───────────────────────────────────────────────────────

export async function briefing() {
  return fetchNCSC();
}

if (process.argv[1]?.endsWith('ncsc.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
