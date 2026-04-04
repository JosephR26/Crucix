// ABUSE.CH — Threat Intelligence Feeds
// URLhaus: malicious URLs distributing malware.
// MalwareBazaar: malware sample hashes (SHA256, MD5, tags).
// SSL Blacklist: malicious SSL certificates (C2 servers, RATs, botnets).
// No API key required for basic feeds. Free CSV/JSON endpoints.
//
// Implements SourceAdapter interface. Retains legacy briefing() export.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'ABUSE.CH';

const ENDPOINTS = {
  // URLhaus — recent malicious URLs (online status only, last 30 days, CSV)
  urlhaus:       'https://urlhaus.abuse.ch/downloads/text_online/',
  // MalwareBazaar — recent samples with tags (JSON, last 100)
  malwareBazaar: 'https://mb-api.abuse.ch/api/v1/',
  // SSL Blacklist — recently added blacklisted SSL certs
  sslbl:         'https://sslbl.abuse.ch/blacklist/sslblacklist.csv',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseURLhaus(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  return rawText
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .slice(0, 200)
    .map(l => l.trim())
    .filter(Boolean);
}

function parseSSLBL(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = rawText.split('\n').filter(l => l && !l.startsWith('#'));
  return lines.slice(0, 100).map(l => {
    const [listingDate, sha1, listingReason] = l.split(',');
    return { listingDate: listingDate?.trim(), sha1: sha1?.trim(), listingReason: listingReason?.trim() };
  }).filter(r => r.sha1);
}

function topTags(samples) {
  const counts = {};
  for (const s of samples) {
    for (const tag of (s.tags || [])) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => ({ tag, count }));
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchAbuseCH() {
  // URLhaus only needs a GET; MalwareBazaar needs a POST
  const [urlhausRaw, sslblRaw] = await Promise.all([
    safeFetch(ENDPOINTS.urlhaus, { timeout: 20000 }),
    safeFetch(ENDPOINTS.sslbl,   { timeout: 20000 }),
  ]);

  // MalwareBazaar — POST query for recent samples
  let bzData = { query_status: 'error', data: [] };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(ENDPOINTS.malwareBazaar, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'Crucix/1.0',
      },
      body: 'query=get_recent&selector=100',
    });
    clearTimeout(timer);
    if (res.ok) bzData = await res.json();
  } catch (_) { /* silently degrade */ }

  // Parse URLhaus
  const activeURLs    = parseURLhaus(urlhausRaw?.rawText || '');

  // Parse MalwareBazaar
  const bzSamples     = Array.isArray(bzData.data) ? bzData.data : [];
  const last24hSamples = bzSamples.filter(s => {
    const added = new Date(s.first_seen);
    return !isNaN(added) && (Date.now() - added.getTime()) < 86400_000;
  });
  const tags          = topTags(bzSamples);

  // Parse SSL blacklist
  const sslBlacklisted = parseSSLBL(sslblRaw?.rawText || '');
  // Group by reason
  const byReason = {};
  for (const r of sslBlacklisted) {
    byReason[r.listingReason] = (byReason[r.listingReason] || 0) + 1;
  }

  // Signals
  const signals = [];

  if (activeURLs.length > 500) {
    signals.push({
      severity: 'high',
      signal:   `${activeURLs.length} active malware-distributing URLs tracked by URLhaus`,
    });
  }
  if (last24hSamples.length > 20) {
    signals.push({
      severity: 'high',
      signal:   `${last24hSamples.length} new malware samples submitted to MalwareBazaar in last 24 h`,
    });
  }
  if (tags.length > 0) {
    const dominant = tags[0];
    signals.push({
      severity: dominant.count > 10 ? 'critical' : 'medium',
      signal:   `Dominant malware family: "${dominant.tag}" (${dominant.count} samples) — potential campaign activity`,
    });
  }
  const c2Certs = sslBlacklisted.filter(r => r.listingReason?.toLowerCase().includes('c2') || r.listingReason?.toLowerCase().includes('rat'));
  if (c2Certs.length > 10) {
    signals.push({
      severity: 'high',
      signal:   `${c2Certs.length} C2/RAT SSL certificates blacklisted — active botnet infrastructure detected`,
    });
  }

  // Events
  const events = [];

  for (const s of last24hSamples.slice(0, 10)) {
    events.push(makeEvent({
      id:          s.sha256_hash || `bz-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      type:        EVENT_TYPES.VULN_EXPLOITED,
      timestamp:   s.first_seen ? new Date(s.first_seen).toISOString() : new Date().toISOString(),
      title:       `MalwareBazaar: ${(s.tags || ['unknown']).slice(0,3).join(', ')} — ${s.file_type || 'unknown'}`.substring(0, 120),
      description: `SHA256: ${s.sha256_hash}  File: ${s.file_name || '?'}  Size: ${s.file_size ?? '?'} bytes  Reporter: ${s.reporter || '?'}`.substring(0, 500),
      severity:    (s.tags || []).some(t => ['ransomware','apt','dropper'].includes(t.toLowerCase())) ? 'critical' : 'high',
      assets: {
        iocs: [s.sha256_hash, s.md5_hash].filter(Boolean),
      },
    }, SOURCE_NAME));
  }

  return {
    source:    SOURCE_NAME,
    timestamp: new Date().toISOString(),
    status:    'active',
    summary: {
      urlhausActive:       activeURLs.length,
      malwareBazaar24h:    last24hSamples.length,
      malwareBazaarTotal:  bzSamples.length,
      sslBlacklisted:      sslBlacklisted.length,
      topMalwareFamilies:  tags.slice(0, 10),
      sslByReason:         byReason,
    },
    recentSamples: last24hSamples.slice(0, 20).map(s => ({
      sha256:    s.sha256_hash,
      fileName:  s.file_name,
      fileType:  s.file_type,
      tags:      s.tags,
      firstSeen: s.first_seen,
      reporter:  s.reporter,
    })),
    topActiveURLs:   activeURLs.slice(0, 20),
    sslBlacklisted:  sslBlacklisted.slice(0, 20),
    events,
    signals,
  };
}

// ─── SourceAdapter export ────────────────────────────────────────────────────

const abuseCHAdapter = createAdapter({
  name:           SOURCE_NAME,
  tier:           3,
  requiresApiKey: false,

  async fetch(ctx) { // eslint-disable-line no-unused-vars
    const result = await fetchAbuseCH();
    return {
      source:         result.source,
      timestamp:      result.timestamp,
      events:         result.events || [],
      summary:        result.summary || {},
      signals:        (result.signals || []).map(s => s.signal),
      recentSamples:  result.recentSamples,
      topActiveURLs:  result.topActiveURLs,
      sslBlacklisted: result.sslBlacklisted,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export default abuseCHAdapter;

// ─── Legacy briefing() ───────────────────────────────────────────────────────

export async function briefing() {
  return fetchAbuseCH();
}

if (process.argv[1]?.endsWith('abuse-ch.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
