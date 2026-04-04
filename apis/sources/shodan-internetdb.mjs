// SHODAN INTERNETDB — Passive IP Intelligence
// Free, no API key. Resolves IPs to open ports, hostnames, CPEs, CVEs,
// and tags (honeypot, tor, vpn, cdn, etc.) from Shodan's passive scan database.
//
// Primary use: enrich IOCs from abuse-ch, cisa-kev, or any source that
// produces IP addresses. Generates "live exposed infrastructure" signals
// when a KEV CVE is found on a reachable host.
//
// Rate limit: ~1 req/s is safe. Batch lookups are parallelised with a
// concurrency cap to avoid hammering the endpoint.
//
// Implements SourceAdapter interface. Retains legacy briefing() export.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'SHODAN-INTERNETDB';
const BASE_URL    = 'https://internetdb.shodan.io';

// ─── Default seed IPs ───────────────────────────────────────────────────────
// These are well-known threat-actor / scanner IP ranges used as seed lookups
// when the adapter is run standalone or without external IOC input.
// In production, call enrichIPs() with your own IOC list from abuse-ch etc.

const SEED_IPS = [
  // Shadowserver scanners (benign but useful to verify DB is live)
  '93.120.27.62',
  '89.248.165.162',
  // Common C2 / bulletproof hosting ranges (Psychz, Frantech)
  '192.161.187.200',
  '198.98.51.189',
  // Shodan crawler itself
  '66.240.236.119',
  '71.6.135.131',
  '71.6.165.200',
  '71.6.167.142',
  '82.221.105.7',
  '85.25.43.94',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function lookupIP(ip) {
  const data = await safeFetch(`${BASE_URL}/${ip}`, { timeout: 10000 });
  if (data.error) return { ip, error: data.error };
  return {
    ip,
    ports:     data.ports     || [],
    cpes:      data.cpes      || [],
    cves:      data.cves      || [],
    hostnames: data.hostnames || [],
    tags:      data.tags      || [],
  };
}

// Parallelise with concurrency cap
async function batchLookup(ips, concurrency = 5) {
  const results = [];
  for (let i = 0; i < ips.length; i += concurrency) {
    const slice = ips.slice(i, i + concurrency);
    const batch = await Promise.all(slice.map(lookupIP));
    results.push(...batch);
    if (i + concurrency < ips.length) {
      await new Promise(r => setTimeout(r, 1100)); // respect ~1 req/s
    }
  }
  return results;
}

function severityForHost(host) {
  if (!host || host.error) return 'low';
  // Critical: has CVEs AND suspicious tags
  const dangerTags = ['malware', 'c2', 'botnet', 'scanner', 'tor'];
  const hasDangerTag = host.tags.some(t => dangerTags.includes(t.toLowerCase()));
  if (host.cves.length > 0 && hasDangerTag) return 'critical';
  if (host.cves.length > 3)                 return 'high';
  if (host.cves.length > 0)                 return 'medium';
  if (hasDangerTag)                          return 'medium';
  return 'low';
}

// ─── Core fetch ──────────────────────────────────────────────────────────────

async function fetchShodanInternetDB(ips = SEED_IPS) {
  const hosts = await batchLookup(ips.slice(0, 20)); // cap at 20 IPs per sweep

  const valid   = hosts.filter(h => !h.error);
  const errored = hosts.filter(h =>  h.error);

  // Aggregate stats
  const allCVEs  = [...new Set(valid.flatMap(h => h.cves))];
  const allPorts = valid.flatMap(h => h.ports);
  const portFreq = {};
  for (const p of allPorts) portFreq[p] = (portFreq[p] || 0) + 1;
  const topPorts = Object.entries(portFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([port, count]) => ({ port: Number(port), count }));

  const tagFreq = {};
  for (const h of valid) {
    for (const t of h.tags) tagFreq[t] = (tagFreq[t] || 0) + 1;
  }

  // Sort hosts by severity
  const ranked = valid
    .map(h => ({ ...h, severity: severityForHost(h) }))
    .sort((a, b) => {
      const order = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
    });

  // Signals
  const signals = [];
  const criticalHosts = ranked.filter(h => h.severity === 'critical');
  const highHosts     = ranked.filter(h => h.severity === 'high');

  if (criticalHosts.length > 0) {
    signals.push({
      severity: 'critical',
      signal:   `${criticalHosts.length} host(s) with CVEs + malicious tags: ${criticalHosts.map(h => h.ip).join(', ')}`,
    });
  }
  if (allCVEs.length > 5) {
    signals.push({
      severity: 'high',
      signal:   `${allCVEs.length} distinct CVEs detected across ${valid.length} queried hosts — active exposure`,
    });
  }
  if (highHosts.length > 0) {
    signals.push({
      severity: 'high',
      signal:   `${highHosts.length} host(s) with 3+ CVEs: ${highHosts.map(h => `${h.ip} (${h.cves.length} CVEs)`).join('; ')}`,
    });
  }
  if (tagFreq['tor'] > 0) {
    signals.push({
      severity: 'medium',
      signal:   `${tagFreq['tor']} queried IP(s) flagged as Tor exit nodes`,
    });
  }

  // Events — one per critical/high host
  const events = ranked
    .filter(h => ['critical', 'high'].includes(h.severity))
    .slice(0, 10)
    .map(h => makeEvent({
      id:          `shodan-${h.ip}-${Date.now()}`,
      type:        EVENT_TYPES.TRAFFIC_ANOMALY,
      timestamp:   new Date().toISOString(),
      title:       `Exposed host ${h.ip} — ${h.cves.length} CVE(s), ports: ${h.ports.slice(0,5).join(',')}`.substring(0, 120),
      description: `Tags: ${h.tags.join(', ') || 'none'}  CVEs: ${h.cves.slice(0,5).join(', ') || 'none'}  Hostnames: ${h.hostnames.slice(0,3).join(', ') || 'none'}`.substring(0, 500),
      severity:    h.severity,
      assets: {
        ips:  [h.ip],
        cves: h.cves.slice(0, 10),
        iocs: h.hostnames.slice(0, 5),
      },
    }, SOURCE_NAME));

  return {
    source:    SOURCE_NAME,
    timestamp: new Date().toISOString(),
    status:    'active',
    summary: {
      queried:       ips.length,
      resolved:      valid.length,
      errored:       errored.length,
      uniqueCVEs:    allCVEs.length,
      topPorts,
      tagBreakdown:  tagFreq,
      criticalHosts: criticalHosts.length,
      highHosts:     highHosts.length,
    },
    hosts:  ranked,
    events,
    signals,
  };
}

// ─── Public enrichment helper ─────────────────────────────────────────────────
// Called by other sources (e.g. abuse-ch) to enrich their IOC IPs.
// Returns a map of ip → host record for fast lookup.

export async function enrichIPs(ipList) {
  const hosts = await batchLookup([...new Set(ipList)].slice(0, 20));
  return Object.fromEntries(hosts.map(h => [h.ip, h]));
}

// ─── SourceAdapter export ─────────────────────────────────────────────────────

const shodanInternetDBAdapter = createAdapter({
  name:           SOURCE_NAME,
  tier:           3,
  requiresApiKey: false,

  async fetch(ctx) { // eslint-disable-line no-unused-vars
    const result = await fetchShodanInternetDB();
    return {
      source:    result.source,
      timestamp: result.timestamp,
      events:    result.events || [],
      summary:   result.summary || {},
      signals:   (result.signals || []).map(s => s.signal),
      hosts:     result.hosts,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export default shodanInternetDBAdapter;

// ─── Legacy briefing() ────────────────────────────────────────────────────────

export async function briefing() {
  return fetchShodanInternetDB();
}

if (process.argv[1]?.endsWith('shodan-internetdb.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
