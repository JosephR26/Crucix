// ONS — UK Office for National Statistics
// No auth required. Pulls latest GDP growth, unemployment rate, and CPI inflation.
// Uses the ONS website's public JSON timeseries endpoints.

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://www.ons.gov.uk';

// Timeseries IDs:
// IHYQ/PN2 = GDP quarterly growth (%, CVM, seasonally adjusted)
// MGSX/LMS = Unemployment rate (%, 16+, seasonally adjusted)
// L55O/MM23 = CPI annual rate (%)
const SERIES = [
  { id: 'gdp',           path: '/economy/grossdomesticproductgdp/timeseries/ihyq/pn2/data',                         label: 'GDP Growth (Q/Q %)',  unit: '%' },
  { id: 'unemployment',  path: '/employmentandlabourmarket/peoplenotinwork/unemployment/timeseries/mgsx/lms/data',   label: 'Unemployment Rate',   unit: '%' },
  { id: 'cpi',           path: '/economy/inflationandpriceindices/timeseries/l55o/mm23/data',                        label: 'CPI Inflation (Y/Y)', unit: '%' },
];

function latestEntries(data, key, count = 6) {
  const arr = data?.[key];
  if (!Array.isArray(arr)) return [];
  return arr.slice(-count).map(e => ({
    date: e.date,
    value: parseFloat(e.value) || null,
    label: e.label || e.date,
  }));
}

async function fetchSeries(s) {
  const data = await safeFetch(`${BASE}${s.path}`, { timeout: 12000 });
  if (data.error) return { id: s.id, label: s.label, unit: s.unit, error: data.error };

  // GDP uses quarters, unemployment/CPI use months
  const isQuarterly = s.id === 'gdp';
  const recent = latestEntries(data, isQuarterly ? 'quarters' : 'months', 6);
  const latest = recent[recent.length - 1] || null;

  return {
    id: s.id,
    label: s.label,
    unit: s.unit,
    current: latest?.value ?? null,
    currentPeriod: latest?.date ?? null,
    trend: recent.map(e => ({ date: e.date, value: e.value })),
    description: data.description?.title || s.label,
  };
}

export async function briefing() {
  const results = await Promise.allSettled(SERIES.map(fetchSeries));

  const indicators = {};
  const signals = [];

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const ind = r.value;
    indicators[ind.id] = ind;

    if (ind.error) continue;

    // Generate signals for notable values
    if (ind.id === 'gdp' && ind.current !== null && ind.current < 0) {
      signals.push(`UK GDP contracted ${ind.current}% in ${ind.currentPeriod}`);
    }
    if (ind.id === 'unemployment' && ind.current !== null && ind.current > 5) {
      signals.push(`UK unemployment elevated at ${ind.current}% (${ind.currentPeriod})`);
    }
    if (ind.id === 'cpi' && ind.current !== null && ind.current > 4) {
      signals.push(`UK CPI inflation high at ${ind.current}% (${ind.currentPeriod})`);
    }
  }

  return {
    source: 'ONS',
    timestamp: new Date().toISOString(),
    indicators,
    signals,
    count: Object.keys(indicators).length,
  };
}

// Run standalone: node apis/sources/ons.mjs
if (process.argv[1]?.endsWith('ons.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
