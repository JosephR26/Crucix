// UKHSA — UK Health Security Agency Dashboard
// No auth required. Pulls latest COVID-19, Influenza, and RSV surveillance data for England.
// API docs: https://api.ukhsa-dashboard.data.gov.uk/api/swagger

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://api.ukhsa-dashboard.data.gov.uk';

// Metrics to track — each is a full API path segment
const METRICS = [
  {
    id: 'covid_cases',
    label: 'COVID-19 Cases (7-day avg)',
    path: '/themes/infectious_disease/sub_themes/respiratory/topics/COVID-19/geography_types/Nation/geographies/England/metrics/COVID-19_cases_countRollingMean',
  },
  {
    id: 'covid_admissions',
    label: 'COVID-19 Hospital Admissions (7-day avg)',
    path: '/themes/infectious_disease/sub_themes/respiratory/topics/COVID-19/geography_types/Nation/geographies/England/metrics/COVID-19_healthcare_admissionRollingMean',
  },
  {
    id: 'flu_positivity',
    label: 'Influenza Test Positivity (weekly)',
    path: '/themes/infectious_disease/sub_themes/respiratory/topics/Influenza/geography_types/Nation/geographies/England/metrics/influenza_testing_positivityByWeek',
  },
  {
    id: 'flu_hospital',
    label: 'Influenza Hospital Admission Rate (weekly)',
    path: '/themes/infectious_disease/sub_themes/respiratory/topics/Influenza/geography_types/Nation/geographies/England/metrics/influenza_healthcare_hospitalAdmissionRateByWeek',
  },
];

async function fetchLatest(metric) {
  // First request to get total count, then fetch last page for most recent data
  const countRes = await safeFetch(`${BASE}${metric.path}?page_size=1`, {
    timeout: 12000,
    headers: { Accept: 'application/json' },
  });

  if (countRes.error || !countRes.count) {
    return { id: metric.id, label: metric.label, error: countRes.error || 'No data' };
  }

  // Fetch last 14 data points (2 weeks daily or ~3 weeks weekly)
  const total = countRes.count;
  const pageSize = 14;
  const lastPage = Math.ceil(total / pageSize);

  const data = await safeFetch(`${BASE}${metric.path}?page_size=${pageSize}&page=${lastPage}`, {
    timeout: 12000,
    headers: { Accept: 'application/json' },
  });

  if (data.error || !data.results) {
    return { id: metric.id, label: metric.label, error: data.error || 'No results' };
  }

  const points = data.results.map(r => ({
    date: r.date,
    value: r.metric_value,
  }));

  const latest = points[points.length - 1];

  return {
    id: metric.id,
    label: metric.label,
    current: latest?.value ?? null,
    currentDate: latest?.date ?? null,
    trend: points,
  };
}

export async function briefing() {
  const results = await Promise.allSettled(METRICS.map(fetchLatest));

  const metrics = {};
  const signals = [];

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const m = r.value;
    metrics[m.id] = m;

    if (m.error) continue;

    // Flag notable values
    if (m.id === 'covid_cases' && m.current > 500) {
      signals.push(`UK COVID-19 7-day avg cases elevated: ${Math.round(m.current)} (${m.currentDate})`);
    }
    if (m.id === 'covid_admissions' && m.current > 100) {
      signals.push(`UK COVID-19 hospital admissions rising: ${Math.round(m.current)}/day avg (${m.currentDate})`);
    }
    if (m.id === 'flu_positivity' && m.current > 10) {
      signals.push(`UK influenza test positivity high: ${m.current}% (${m.currentDate})`);
    }
  }

  return {
    source: 'UKHSA',
    timestamp: new Date().toISOString(),
    metrics,
    signals,
    count: Object.keys(metrics).length,
  };
}

// Run standalone: node apis/sources/ukhsa.mjs
if (process.argv[1]?.endsWith('ukhsa.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
