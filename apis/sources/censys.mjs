// CENSYS — Certificate Transparency + Host Discovery
// Free tier: 250 queries/month on Search API. No key needed for View API.
// Tracks: newly issued TLS certificates (phishing domain detection),
// exposed hosts by service/port, C2 infrastructure via cert fingerprints.
//
// Complements shodan-internetdb.mjs:
// - Shodan: what ports/CVEs are open on a known IP
// - Censys: what new domains/certs appeared, who owns them, are they C2?
//
// requiresApiKey: true — set CENSYS_API_ID and CENSYS_API_SECRET in config.
// Degrades gracefully (empty events) when no key is present.
//
// Implements SourceAdapter interface. Retains legacy briefing() export.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'CENSYS';
const API_BASE    = 'https://search.censys.io/api/v2';

// ─── Suspicious cert signals ─────────────────────────────────────────────────
// Newly issued certs matching these patterns likely indicate:
// - Phishing infrastructure (bank/gov impersonation)
// - C2 staging (Let's Encrypt on fresh VPS with suspicious CN)
// - Credential harvesting kits

const PHISHING_PATTERNS = [
  'paypal', 'microsoft', 'amazon', 'apple', 'google', 'facebook',
  'netflix', 'barclays', 'lloyds', 'natwest', 'hsbc', 'halifax',
  'gov.uk', 'hmrc', 'dvla', 'nhs', 'royal-mail', 'royalmail',
  'coinbase', 'binance', 'kraken', 'metamask',
];

const C2_PATTERNS = [
  'cobalt', 'meterpreter', 'beacon', 'agent', 'implant',
  'c2', 'c&c', 'rat', 'loader', 'payload', 'stage',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAuthHeaders(apiId, apiSecret) {
  const creds = Buffer.from(`${apiId}:${apiSecret}`).toString('base64');
  return { Authorization: `Basic ${creds}` };
}

function classifyCert(cn = '', sans = []) {
  const all = [cn, ...sans].map(s => s.toLowerCase());
  const isPhishing = PHISHING_PATTERNS.some(p => all.some(s => s.includes(p)));
  const isC2       = C2_PATTERNS.some(p => all.some(s => s.includes(p)));
  if (isC2)       return 'c2';
  if (isPhishing) return 'phishing';
  return 'clean';
}

function certSeverity(classification) {
  if (classification === 'c2')       return 'critical';
  if (classification === 'phishing') return 'high';
  return 'low';
}

// ─── Core fetch ──────────────────────────────────────────────────────────────

async function fetchCensys(apiId, apiSecret) {
  if (!apiId || !apiSecret) {
    return {
      source:    SOURCE_NAME,
      timestamp: new Date().toISOString(),
      error:     'CENSYS_API_ID and CENSYS_API_SECRET not configured — skipping',
      events:    [],
      summary:   {},
      signals:   [],
    };
  }

  const headers = makeAuthHeaders(apiId, apiSecret);

  // Search 1: Recently issued certs with suspicious CNs (phishing/C2 detection)
  // Search 2: Exposed hosts running known C2 frameworks (Cobalt Strike default certs etc.)
  const [certSearchRaw, hostSearchRaw] = await Promise.all([
    safeFetch(`${API_BASE}/certificates/search`, {
      timeout: 20000,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify({
        q:        'parsed.validity_period.not_before:[now-24h TO now] AND parsed.subject_dn:*',
        per_page: 50,
        fields:   ['parsed.subject_dn', 'parsed.names', 'parsed.issuer_dn', 'parsed.validity_period', 'fingerprint_sha256'],
      }),
    }),
    safeFetch(`${API_BASE}/hosts/search`, {
      timeout: 20000,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      body: JSON.stringify({
        q:        'services.tls.certificates.leaf_data.subject.common_name:(cobalt OR beacon OR meterpreter OR c2agent)',
        per_page: 25,
        fields:   ['ip', 'services', 'location', 'autonomous_system'],
      }),
    }),
  ]);

  // ── Process certs ──
  const certs = (certSearchRaw?.result?.hits || []).map(hit => {
    const cn   = hit?.parsed?.subject_dn || '';
    const sans = hit?.parsed?.names || [];
    const cls  = classifyCert(cn, sans);
    return {
      fingerprint: hit?.fingerprint_sha256 || '',
      subjectDN:   cn,
      names:       sans.slice(0, 10),
      issuer:      hit?.parsed?.issuer_dn || '',
      notBefore:   hit?.parsed?.validity_period?.not_before || '',
      notAfter:    hit?.parsed?.validity_period?.not_after  || '',
      classification: cls,
      severity:    certSeverity(cls),
    };
  });

  const suspiciousCerts = certs.filter(c => c.classification !== 'clean');
  const phishingCerts   = certs.filter(c => c.classification === 'phishing');
  const c2Certs         = certs.filter(c => c.classification === 'c2');

  // ── Process C2 hosts ──
  const c2Hosts = (hostSearchRaw?.result?.hits || []).map(hit => ({
    ip:      hit?.ip || '',
    asn:     hit?.autonomous_system?.asn   ? `AS${hit.autonomous_system.asn}` : '',
    asnName: hit?.autonomous_system?.name  || '',
    country: hit?.location?.country        || '',
    city:    hit?.location?.city           || '',
    ports:   (hit?.services || []).map(s => s.port).filter(Boolean),
  }));

  // ── Signals ──
  const signals = [];

  if (c2Certs.length > 0) {
    signals.push({
      severity: 'critical',
      signal:   `${c2Certs.length} cert(s) with C2 indicators issued in last 24 h — active staging infrastructure`,
    });
  }
  if (phishingCerts.length > 0) {
    const targets = [...new Set(phishingCerts.flatMap(c => c.names))]
      .filter(n => PHISHING_PATTERNS.some(p => n.includes(p)))
      .slice(0, 5);
    signals.push({
      severity: 'high',
      signal:   `${phishingCerts.length} phishing cert(s) targeting: ${targets.join(', ')}`,
    });
  }
  if (c2Hosts.length > 0) {
    signals.push({
      severity: 'critical',
      signal:   `${c2Hosts.length} host(s) with C2 framework TLS certs exposed — potential active C2 infrastructure: ${c2Hosts.map(h => h.ip).join(', ')}`,
    });
  }

  // ── Events ──
  const events = [
    ...suspiciousCerts.slice(0, 10).map(c => makeEvent({
      id:          `censys-cert-${c.fingerprint || Date.now()}`,
      type:        EVENT_TYPES.TRAFFIC_ANOMALY,
      timestamp:   c.notBefore ? new Date(c.notBefore).toISOString() : new Date().toISOString(),
      title:       `[${c.classification.toUpperCase()}] Cert: ${c.subjectDN}`.substring(0, 120),
      description: `Names: ${c.names.slice(0,5).join(', ')}  Issuer: ${c.issuer}  SHA256: ${c.fingerprint}`.substring(0, 500),
      severity:    c.severity,
      assets:      { domains: c.names.slice(0, 5), iocs: [c.fingerprint] },
    }, SOURCE_NAME)),
    ...c2Hosts.slice(0, 5).map(h => makeEvent({
      id:          `censys-host-${h.ip}-${Date.now()}`,
      type:        EVENT_TYPES.TRAFFIC_ANOMALY,
      timestamp:   new Date().toISOString(),
      title:       `C2 Host: ${h.ip} (${h.asnName}, ${h.country})`.substring(0, 120),
      description: `ASN: ${h.asn}  City: ${h.city}  Open ports: ${h.ports.join(', ')}`.substring(0, 500),
      severity:    'critical',
      assets:      { ips: [h.ip], asns: [h.asn] },
    }, SOURCE_NAME)),
  ];

  return {
    source:    SOURCE_NAME,
    timestamp: new Date().toISOString(),
    status:    'active',
    summary: {
      certsScanned:    certs.length,
      suspiciousCerts: suspiciousCerts.length,
      phishingCerts:   phishingCerts.length,
      c2Certs:         c2Certs.length,
      c2HostsFound:    c2Hosts.length,
    },
    suspiciousCerts: suspiciousCerts.slice(0, 20),
    c2Hosts:         c2Hosts.slice(0, 10),
    events,
    signals,
  };
}

// ─── SourceAdapter export ─────────────────────────────────────────────────────

const censysAdapter = createAdapter({
  name:           SOURCE_NAME,
  tier:           3,
  requiresApiKey: true,

  async fetch(ctx) {
    const apiId     = ctx?.apiKey || ctx?.config?.CENSYS_API_ID     || process.env.CENSYS_API_ID;
    const apiSecret =               ctx?.config?.CENSYS_API_SECRET  || process.env.CENSYS_API_SECRET;
    const result    = await fetchCensys(apiId, apiSecret);
    return {
      source:          result.source,
      timestamp:       result.timestamp,
      events:          result.events || [],
      summary:         result.summary || {},
      signals:         (result.signals || []).map(s => s.signal),
      suspiciousCerts: result.suspiciousCerts,
      c2Hosts:         result.c2Hosts,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export default censysAdapter;

// ─── Legacy briefing() ────────────────────────────────────────────────────────

export async function briefing() {
  const apiId     = process.env.CENSYS_API_ID;
  const apiSecret = process.env.CENSYS_API_SECRET;
  return fetchCensys(apiId, apiSecret);
}

if (process.argv[1]?.endsWith('censys.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
