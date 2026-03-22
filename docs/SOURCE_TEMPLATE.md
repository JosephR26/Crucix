# Crucix Source Adapter — Implementation Guide

This document shows how to add a new OSINT or data source to Crucix using the `SourceAdapter` interface.

---

## Interface Contract

Every source module must:
1. Export a default `SourceAdapter` object created with `createAdapter()`
2. Export a legacy `briefing()` function for backwards compatibility with the orchestrator

The adapter lives in `apis/sources/your-source.mjs`.

---

## Minimal Template

```js
// apis/sources/my-source.mjs
//
// My Source — short description of what this feeds into Crucix.
// Auth required: YES/NO
// Docs: https://example.com/api-docs

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'MySource';
const API_URL = 'https://api.example.com/data';

// ─── Core fetch logic ────────────────────────────────────────────────────────

async function fetchData(apiKey) {
  const data = await safeFetch(API_URL, {
    timeout: 20000,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });

  if (data.error) {
    return { source: SOURCE_NAME, timestamp: new Date().toISOString(), error: data.error, events: [], summary: {} };
  }

  // --- Transform raw data ---
  const items = data.items || [];

  // Normalize to NormalizedEvent[]
  const events = items.map(item =>
    makeEvent({
      id: item.id,
      type: EVENT_TYPES.NEWS_ITEM,           // pick the right type from EVENT_TYPES
      timestamp: item.created_at,
      title: item.title?.substring(0, 120),
      description: item.body?.substring(0, 500),
      severity: item.critical ? 'high' : 'low',
      geo: item.lat ? { lat: item.lat, lon: item.lon, label: item.location } : undefined,
      assets: item.ip ? { ips: [item.ip] } : undefined,
    }, SOURCE_NAME)
  );

  const summary = {
    total: items.length,
    // ... any aggregate counts relevant to delta engine
  };

  return {
    source: SOURCE_NAME,
    timestamp: new Date().toISOString(),
    events,
    summary,
    // add any extra fields you want to surface in the dashboard
    rawItems: items.slice(0, 20),
  };
}

// ─── SourceAdapter export ────────────────────────────────────────────────────

const myAdapter = createAdapter({
  name: SOURCE_NAME,
  tier: 3,              // 1=OSINT, 2=Economic, 3=Env/Social, 4=Space, 5=Market, 6=Cyber
  requiresApiKey: true, // set to false if no key needed

  async fetch(ctx) {
    const result = await fetchData(ctx.apiKey);
    return {
      source: result.source,
      timestamp: result.timestamp,
      events: result.events || [],
      summary: result.summary || {},
      ...(result.error ? { error: result.error } : {}),
      rawItems: result.rawItems,  // keep any extra dashboard fields
    };
  },
});

export default myAdapter;

// ─── Legacy briefing() export ────────────────────────────────────────────────
// Keep this so apis/briefing.mjs works without modification.

export async function briefing(apiKey) {
  return fetchData(apiKey);
}

// Run standalone: node apis/sources/my-source.mjs
if (process.argv[1]?.endsWith('my-source.mjs')) {
  const data = await briefing(process.env.MY_API_KEY);
  console.log(JSON.stringify(data, null, 2));
}
```

---

## Wiring the Source into the Sweep

### 1. Register in `apis/briefing.mjs`

```js
// Add import at the top:
import { briefing as mySource } from './sources/my-source.mjs';

// Add to fullBriefing() allPromises array (in the right tier):
runSource('MySource', mySource, process.env.MY_API_KEY),
```

### 2. Surface data in the dashboard (`dashboard/inject.mjs`)

In the `synthesize(raw)` function, map your source's data from `raw.sources['MySource']` into the synthesized object:

```js
// Inside synthesize():
const mySource = raw.sources['MySource'] || {};
// ... add to synthesized object:
synthesized.mySource = mySource.rawItems || [];
```

### 3. Add env var documentation

Add your API key to `.env.example`:
```
# My Source API key (get it at https://example.com/api-keys)
MY_API_KEY=
```

And document it in `CONFIGURATION.md` under "Keyed sources".

---

## Event Types

Use the constants from `src/adapters/SourceAdapter.mjs`:

| Constant | Value | Use for |
|----------|-------|---------|
| `EVENT_TYPES.VULN_EXPLOITED` | `vuln.exploited` | CVEs, exploits, KEV entries |
| `EVENT_TYPES.INTERNET_OUTAGE` | `internet.outage` | BGP hijacks, outages |
| `EVENT_TYPES.TRAFFIC_ANOMALY` | `traffic.anomaly` | DDoS, traffic spikes |
| `EVENT_TYPES.CONFLICT_EVENT` | `conflict.event` | ACLED events, battle reports |
| `EVENT_TYPES.SANCTIONS_ADDED` | `sanctions.added` | OFAC/OpenSanctions updates |
| `EVENT_TYPES.HEALTH_ALERT` | `health.alert` | WHO alerts, outbreaks |
| `EVENT_TYPES.FIRE_DETECTION` | `fire.detection` | FIRMS thermal alerts |
| `EVENT_TYPES.RADIATION_ANOMALY` | `radiation.anomaly` | Safecast spikes |
| `EVENT_TYPES.AIRCRAFT` | `aircraft.tracked` | OpenSky, ADS-B |
| `EVENT_TYPES.VESSEL` | `vessel.tracked` | Maritime AIS |
| `EVENT_TYPES.OSINT_POST` | `osint.post` | Telegram, Bluesky, Reddit |
| `EVENT_TYPES.NEWS_ITEM` | `news.item` | GDELT, RSS |
| `EVENT_TYPES.ECONOMIC_INDICATOR` | `economic.indicator` | FRED, BLS, EIA |

---

## Severity Levels

| Value | When to use |
|-------|-------------|
| `'critical'` | Actively exploited, ransomware-linked, mass-casualty, nuclear anomaly |
| `'high'` | New exploit in KEV, major conflict escalation, large outage |
| `'medium'` | Elevated activity, moderate market move, regional conflict |
| `'low'` | Background data, status quo, informational |

---

## Design Rules

1. **Never throw** — return `{ error: '...' }` so `runSource()` can report partial failures without killing the sweep.
2. **Degrade gracefully** — if `ctx.apiKey` is missing and `requiresApiKey: true`, return an empty result with a clear error message, not a crash.
3. **Stay within the timeout** — `runSource()` enforces a 30 s hard timeout per source. Use `safeFetch({ timeout: 20000 })` internally to leave headroom.
4. **Keep events small** — strip raw descriptions to 500 chars max; the raw payload sits in `events[n].raw` (omitted from cold storage).
5. **Use stable IDs** — `event.id` should be reproducible across sweeps for the same real-world item (e.g. CVE ID, ICAO hex + date, ACLED event ID). This enables deduplication in the analysis layer.
