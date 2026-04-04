// GDACS — Global Disaster Alert and Coordination System
// UN-backed real-time disaster alerting: earthquakes, cyclones, floods,
// volcanoes, droughts, wildfires — with impact scoring (Green/Orange/Red).
// No API key required. GeoRSS + JSON endpoints.
//
// Pairs with firms.mjs (fires), noaa.mjs (weather), and space.mjs (geomagnetic).
// Implements SourceAdapter interface. Retains legacy briefing() export.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'GDACS';

const ENDPOINTS = {
  current:  'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=Green;Orange;Red&eventlist=EQ;TC;FL;VO;DR;WF&limit=50',
  rss:      'https://www.gdacs.org/xml/rss.xml',
};

// Alert level → severity mapping
const LEVEL_MAP = {
  Red:    'critical',
  Orange: 'high',
  Green:  'medium',
};

// Event type labels
const TYPE_MAP = {
  EQ: 'Earthquake',
  TC: 'Tropical Cyclone',
  FL: 'Flood',
  VO: 'Volcano',
  DR: 'Drought',
  WF: 'Wildfire',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseGDACSEvents(data) {
  const features = data?.features || [];
  return features.map(f => {
    const p   = f.properties || {};
    const geo = f.geometry?.coordinates;
    return {
      id:          String(p.eventid || p.eventtype + Date.now()),
      type:        p.eventtype || 'UNK',
      typeName:    TYPE_MAP[p.eventtype] || p.eventtype || 'Unknown',
      alertLevel:  p.alertlevel || 'Green',
      title:       p.name || p.htmldescription?.replace(/<[^>]+>/g, '').trim() || 'Unknown event',
      country:     p.country || '',
      iso3:        p.iso3 || '',
      date:        p.todate || p.fromdate || new Date().toISOString(),
      deaths:      p.deaths ?? 0,
      affected:    p.affected ?? 0,
      url:         p.url?.report || '',
      lat:         geo?.[1] ?? null,
      lon:         geo?.[0] ?? null,
      population:  p.affectedpopulation ?? 0,
    };
  });
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchGDACS() {
  const data = await safeFetch(ENDPOINTS.current, { timeout: 20000 });

  if (data.error) {
    return {
      source:    SOURCE_NAME,
      timestamp: new Date().toISOString(),
      error:     data.error,
      events:    [],
      summary:   {},
      signals:   [],
    };
  }

  const disasters = parseGDACSEvents(data);

  // Count by level
  const byLevel = { Red: 0, Orange: 0, Green: 0 };
  const byType  = {};
  for (const d of disasters) {
    byLevel[d.alertLevel] = (byLevel[d.alertLevel] || 0) + 1;
    byType[d.typeName]    = (byType[d.typeName] || 0) + 1;
  }

  // Sort by severity: Red > Orange > Green
  const ORDER = { Red: 0, Orange: 1, Green: 2 };
  const sorted = [...disasters].sort((a, b) => {
    const lo = (ORDER[a.alertLevel] ?? 3) - (ORDER[b.alertLevel] ?? 3);
    if (lo !== 0) return lo;
    return new Date(b.date) - new Date(a.date);
  });

  // Signals
  const signals = [];
  const redEvents = sorted.filter(d => d.alertLevel === 'Red');
  if (redEvents.length > 0) {
    signals.push({
      severity: 'critical',
      signal:   `${redEvents.length} RED-level disaster event(s) active: ${redEvents.map(d => `${d.typeName} in ${d.country}`).join('; ')}`,
    });
  }
  const orangeEvents = sorted.filter(d => d.alertLevel === 'Orange');
  if (orangeEvents.length > 3) {
    signals.push({
      severity: 'high',
      signal:   `${orangeEvents.length} ORANGE-level events active globally — elevated humanitarian risk`,
    });
  }
  const massCalc = sorted.filter(d => d.affected > 100000);
  if (massCalc.length > 0) {
    signals.push({
      severity: 'high',
      signal:   `Mass-casualty potential: ${massCalc.length} event(s) with >100k people affected`,
    });
  }

  const events = sorted.map(d => makeEvent({
    id:          d.id,
    type:        EVENT_TYPES.WEATHER_SEVERE,
    timestamp:   d.date ? new Date(d.date).toISOString() : new Date().toISOString(),
    title:       `[${d.alertLevel}] ${d.typeName} — ${d.country} ${d.title}`.substring(0, 120),
    description: `Affected: ${d.affected?.toLocaleString() ?? '?'}  Deaths: ${d.deaths ?? '?'}  Population at risk: ${d.population?.toLocaleString() ?? '?'}`.substring(0, 500),
    severity:    LEVEL_MAP[d.alertLevel] || 'low',
    geo:         d.lat != null ? { lat: d.lat, lon: d.lon, label: d.country } : undefined,
  }, SOURCE_NAME));

  return {
    source:    SOURCE_NAME,
    timestamp: new Date().toISOString(),
    status:    'active',
    summary: {
      total:   disasters.length,
      byLevel,
      byType,
      topAffected: sorted.slice(0, 5).map(d => ({
        event:     `${d.typeName} in ${d.country}`,
        level:     d.alertLevel,
        affected:  d.affected,
        deaths:    d.deaths,
      })),
    },
    disasters: sorted,
    events,
    signals,
  };
}

// ─── SourceAdapter export ────────────────────────────────────────────────────

const gdacsAdapter = createAdapter({
  name:           SOURCE_NAME,
  tier:           2,
  requiresApiKey: false,

  async fetch(ctx) { // eslint-disable-line no-unused-vars
    const result = await fetchGDACS();
    return {
      source:    result.source,
      timestamp: result.timestamp,
      events:    result.events || [],
      summary:   result.summary || {},
      signals:   (result.signals || []).map(s => s.signal),
      disasters: result.disasters,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export default gdacsAdapter;

// ─── Legacy briefing() ───────────────────────────────────────────────────────

export async function briefing() {
  return fetchGDACS();
}

if (process.argv[1]?.endsWith('gdacs.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
