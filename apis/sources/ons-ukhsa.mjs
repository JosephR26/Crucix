// ONS / UKHSA — UK Sovereign Statistics
// Office for National Statistics: GDP, CPI inflation, unemployment, trade balance.
// UK Health Security Agency: disease surveillance, outbreak reports.
// No API key required. Official UK government JSON APIs.
//
// Fills the UK data gap — Crucix has BLS/FRED/EIA for the US but
// nothing UK-native until now.
//
// Implements SourceAdapter interface. Retains legacy briefing() export.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'ONS-UKHSA';

// ─── ONS Timeseries API endpoints ────────────────────────────────────────────
// Format: /timeseries/{series_id}/dataset/{dataset_id}/timeseries/{series_id}/data

const ONS_BASE = 'https://api.beta.ons.gov.uk/v1';

const ONS_SERIES = {
  // GDP (monthly, chained volume measure)
  gdp:          { url: `${ONS_BASE}/datasets/GDP/timeseries/ABMI/data`, label: 'GDP (monthly index)' },
  // CPI inflation (all items, 12-month rate)
  cpi:          { url: `${ONS_BASE}/datasets/MM23/timeseries/D7G7/data`, label: 'CPI 12-month rate (%)' },
  // Unemployment rate
  unemployment: { url: `${ONS_BASE}/datasets/LMS/timeseries/MGSX/data`, label: 'Unemployment rate (%)' },
  // UK trade balance (goods + services)
  trade:        { url: `${ONS_BASE}/datasets/PNK7/timeseries/IKBH/data`, label: 'Trade balance (£m)' },
};

// UKHSA — Disease Surveillance Dashboard API (publicly accessible JSON)
const UKHSA_ENDPOINTS = {
  // Weekly national influenza and respiratory virus surveillance
  flu:        'https://ukhsa-dashboard.data.gov.uk/api/headlines/influenza_testing_positivity_by_week/influenza_A_positivity_last_week/',
  covid:      'https://ukhsa-dashboard.data.gov.uk/api/headlines/COVID-19_cases_casesByDay/count_latest/',
  // RSV
  rsv:        'https://ukhsa-dashboard.data.gov.uk/api/headlines/RSV_testing_positivity/RSV_positivity_last_4_weeks/',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function latestONSValue(data) {
  // ONS returns { months: [...], quarters: [...], years: [...] }
  // Prefer months for most granular, fall back to quarters then years
  const series = data?.months || data?.quarters || data?.years || [];
  if (!series.length) return null;
  const latest = series.at(-1);
  return {
    value:  parseFloat(latest?.value ?? latest?.v ?? 'NaN'),
    period: latest?.label || latest?.date || '',
    raw:    latest,
  };
}

function onsChange(data, periods = 3) {
  const series = data?.months || data?.quarters || data?.years || [];
  if (series.length < periods + 1) return null;
  const prev = parseFloat(series.at(-(periods + 1))?.value ?? 'NaN');
  const curr = parseFloat(series.at(-1)?.value ?? 'NaN');
  if (isNaN(prev) || isNaN(curr) || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
}

// ─── Core fetch ──────────────────────────────────────────────────────────────

async function fetchONSUKHSA() {
  // Fetch all ONS series in parallel
  const [gdpRaw, cpiRaw, unemploymentRaw, tradeRaw, fluRaw, covidRaw, rsvRaw] = await Promise.all([
    safeFetch(ONS_SERIES.gdp.url,          { timeout: 20000 }),
    safeFetch(ONS_SERIES.cpi.url,          { timeout: 20000 }),
    safeFetch(ONS_SERIES.unemployment.url, { timeout: 20000 }),
    safeFetch(ONS_SERIES.trade.url,        { timeout: 20000 }),
    safeFetch(UKHSA_ENDPOINTS.flu,   { timeout: 15000 }),
    safeFetch(UKHSA_ENDPOINTS.covid, { timeout: 15000 }),
    safeFetch(UKHSA_ENDPOINTS.rsv,   { timeout: 15000 }),
  ]);

  // ── ONS indicators ──
  const gdp          = latestONSValue(gdpRaw);
  const cpi          = latestONSValue(cpiRaw);
  const unemployment = latestONSValue(unemploymentRaw);
  const trade        = latestONSValue(tradeRaw);

  const gdp3mChange  = onsChange(gdpRaw,          3);
  const cpiChange    = onsChange(cpiRaw,           3);
  const unempChange  = onsChange(unemploymentRaw,  3);

  // ── UKHSA health indicators ──
  // Dashboard API returns { value, period, ... } for headline metrics
  const fluPositivity  = fluRaw?.value   ?? fluRaw?.data?.value   ?? null;
  const covidCount     = covidRaw?.value ?? covidRaw?.data?.value ?? null;
  const rsvPositivity  = rsvRaw?.value   ?? rsvRaw?.data?.value   ?? null;

  // ── Signals ──
  const signals = [];

  // GDP contraction: 2 consecutive down quarters = recession signal
  if (gdp3mChange !== null && gdp3mChange < -0.5) {
    signals.push({
      severity: 'high',
      signal:   `UK GDP contracted ${gdp3mChange.toFixed(2)}% over 3 months (${gdp?.period}) — recession risk elevated`,
    });
  }

  // CPI above 4% = elevated inflation signal
  if (cpi?.value > 4) {
    signals.push({
      severity: 'medium',
      signal:   `UK CPI inflation at ${cpi.value}% (${cpi.period}) — above Bank of England 2% target by ${(cpi.value - 2).toFixed(1)}pp`,
    });
  }

  // Unemployment spike
  if (unempChange !== null && unempChange > 5) {
    signals.push({
      severity: 'medium',
      signal:   `UK unemployment rate rising: ${unemployment?.value}% (${unemployment?.period}), up ${unempChange.toFixed(1)}% over 3m`,
    });
  }

  // Trade deficit widening
  if (trade?.value !== null && trade.value < -10000) {
    signals.push({
      severity: 'medium',
      signal:   `UK trade deficit: £${Math.abs(trade.value).toLocaleString()}m (${trade.period}) — supply chain / currency pressure`,
    });
  }

  // UKHSA: flu positivity >15% = seasonal pressure
  if (fluPositivity !== null && parseFloat(fluPositivity) > 15) {
    signals.push({
      severity: 'medium',
      signal:   `UKHSA: Influenza A positivity at ${fluPositivity}% — above seasonal threshold, healthcare pressure likely`,
    });
  }

  // UKHSA: COVID spike
  if (covidCount !== null && parseFloat(covidCount) > 50000) {
    signals.push({
      severity: 'high',
      signal:   `UKHSA: ${Number(covidCount).toLocaleString()} COVID-19 cases reported (latest period) — significant wave activity`,
    });
  }

  // ── Events ──
  const events = [];

  if (gdp3mChange !== null && gdp3mChange < -0.5) {
    events.push(makeEvent({
      id:          `ons-gdp-${gdp?.period}`,
      type:        EVENT_TYPES.ECONOMIC_INDICATOR,
      timestamp:   new Date().toISOString(),
      title:       `UK GDP: ${gdp?.value} index (${gdp?.period}), 3m change: ${gdp3mChange?.toFixed(2)}%`.substring(0, 120),
      description: `ONS GDP monthly chained volume measure. 3-month trend: ${gdp3mChange?.toFixed(2)}%.`.substring(0, 500),
      severity:    'high',
    }, SOURCE_NAME));
  }

  if (cpi?.value > 4) {
    events.push(makeEvent({
      id:          `ons-cpi-${cpi?.period}`,
      type:        EVENT_TYPES.ECONOMIC_INDICATOR,
      timestamp:   new Date().toISOString(),
      title:       `UK CPI: ${cpi?.value}% (${cpi?.period})`.substring(0, 120),
      description: `ONS CPI 12-month inflation rate. Above 4% threshold.`.substring(0, 500),
      severity:    'medium',
    }, SOURCE_NAME));
  }

  return {
    source:    SOURCE_NAME,
    timestamp: new Date().toISOString(),
    status:    'active',
    uk: {
      gdp: {
        value:     gdp?.value  ?? null,
        period:    gdp?.period ?? null,
        change3m:  gdp3mChange,
      },
      cpi: {
        value:     cpi?.value  ?? null,
        period:    cpi?.period ?? null,
        change3m:  cpiChange,
      },
      unemployment: {
        value:     unemployment?.value  ?? null,
        period:    unemployment?.period ?? null,
        change3m:  unempChange,
      },
      tradeBalance: {
        value:     trade?.value  ?? null,
        period:    trade?.period ?? null,
      },
    },
    health: {
      influenzaPositivity: fluPositivity,
      covidCases:          covidCount,
      rsvPositivity,
    },
    events,
    signals,
  };
}

// ─── SourceAdapter export ─────────────────────────────────────────────────────

const onsUKHSAAdapter = createAdapter({
  name:           SOURCE_NAME,
  tier:           3,
  requiresApiKey: false,

  async fetch(ctx) { // eslint-disable-line no-unused-vars
    const result = await fetchONSUKHSA();
    return {
      source:    result.source,
      timestamp: result.timestamp,
      events:    result.events || [],
      summary:   { uk: result.uk, health: result.health },
      signals:   (result.signals || []).map(s => s.signal),
      uk:        result.uk,
      health:    result.health,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export default onsUKHSAAdapter;

// ─── Legacy briefing() ────────────────────────────────────────────────────────

export async function briefing() {
  return fetchONSUKHSA();
}

if (process.argv[1]?.endsWith('ons-ukhsa.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
