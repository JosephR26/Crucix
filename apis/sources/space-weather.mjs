// SPACE WEATHER — NOAA Space Weather Prediction Center
// Solar wind, geomagnetic storm index (Kp), X-ray solar flux, proton flux,
// CME (Coronal Mass Ejection) alerts, aurora forecasts.
// No API key required. Free NOAA JSON endpoints.
//
// Critical for RF engineers: Kp >= 5 degrades HF comms, GPS, and satellite links.
// Pairs with kiwisdr.mjs (RF anomalies), adsb.mjs (GPS-dependent), space.mjs.
// Implements SourceAdapter interface. Retains legacy briefing() export.

import { safeFetch } from '../utils/fetch.mjs';
import { createAdapter, makeEvent, EVENT_TYPES } from '../../src/adapters/SourceAdapter.mjs';

const SOURCE_NAME = 'SPACE-WEATHER';

const ENDPOINTS = {
  kpIndex:      'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  kpForecast:   'https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json',
  xrayFlux:     'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-minute.json',
  solarWind:    'https://services.swpc.noaa.gov/products/solar-wind/plasma-1-hour.json',
  alerts:       'https://services.swpc.noaa.gov/products/alerts.json',
  geoStorm:     'https://services.swpc.noaa.gov/products/noaa-geomagnetic-activity-latest-month.json',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function kpSeverity(kp) {
  const k = parseFloat(kp);
  if (k >= 8)  return 'critical'; // G4-G5: extreme storm
  if (k >= 6)  return 'high';     // G2-G3: moderate-strong
  if (k >= 5)  return 'medium';   // G1: minor storm
  return 'low';
}

function kpStormLabel(kp) {
  const k = parseFloat(kp);
  if (k >= 9)  return 'G5 — EXTREME (radio blackout, satellite drag, widespread auroras)';
  if (k >= 8)  return 'G4 — SEVERE (GPS disrupted, HF blackout at high latitudes)';
  if (k >= 7)  return 'G3 — STRONG (satellite orientation issues, HF degraded)';
  if (k >= 6)  return 'G2 — MODERATE (high-frequency radio fades, aurora at 55° lat)';
  if (k >= 5)  return 'G1 — MINOR (weak power grid fluctuations, aurora possible)';
  return 'QUIET';
}

function xraySeverity(flux) {
  const f = parseFloat(flux);
  if (f >= 1e-3)  return 'critical'; // X10+
  if (f >= 1e-4)  return 'high';     // X1-X10
  if (f >= 1e-5)  return 'medium';   // M-class
  if (f >= 1e-6)  return 'low';      // C-class
  return 'low';
}

function xrayClass(flux) {
  const f = parseFloat(flux);
  if (f >= 1e-3)  return 'X10+';
  if (f >= 1e-4)  return 'X-class';
  if (f >= 1e-5)  return 'M-class';
  if (f >= 1e-6)  return 'C-class';
  return 'B/A-class';
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

async function fetchSpaceWeather() {
  const [kpRaw, kpForecastRaw, xrayRaw, solarWindRaw, alertsRaw] = await Promise.all([
    safeFetch(ENDPOINTS.kpIndex,    { timeout: 15000 }),
    safeFetch(ENDPOINTS.kpForecast, { timeout: 15000 }),
    safeFetch(ENDPOINTS.xrayFlux,   { timeout: 15000 }),
    safeFetch(ENDPOINTS.solarWind,  { timeout: 15000 }),
    safeFetch(ENDPOINTS.alerts,     { timeout: 15000 }),
  ]);

  // ── Kp Index (last 1 min reading) ──
  const kpRecords  = Array.isArray(kpRaw) ? kpRaw : [];
  const latestKp   = kpRecords.at(-1);
  const currentKp  = parseFloat(latestKp?.kp_index ?? latestKp?.[1] ?? 0);
  const kpTime     = latestKp?.time_tag ?? latestKp?.[0] ?? null;

  // ── Kp 24h max ──
  const last24h    = kpRecords.slice(-1440);
  const maxKp24h   = Math.max(...last24h.map(r => parseFloat(r.kp_index ?? r[1] ?? 0)), 0);

  // ── Kp 3-day forecast ──
  const forecastRows = Array.isArray(kpForecastRaw) ? kpForecastRaw.slice(1) : []; // skip header
  const forecastNext = forecastRows.slice(0, 24).map(r => ({
    time: r[0],
    kp:   parseFloat(r[1]),
    observed: r[2],
  })).filter(r => !isNaN(r.kp));
  const forecastPeak = Math.max(...forecastNext.map(r => r.kp), 0);

  // ── X-ray flux (latest) ──
  const xrayRecords  = Array.isArray(xrayRaw) ? xrayRaw : [];
  // GOES primary reports two channels; take the short (0.05-0.4 nm) channel
  const latestXray   = xrayRecords.filter(r => r.energy === '0.05-0.4nm').at(-1)
                    ?? xrayRecords.at(-1)
                    ?? {};
  const currentFlux  = parseFloat(latestXray.flux ?? latestXray[1] ?? 0);

  // ── Solar wind (plasma speed & density) ──
  const windRecords  = Array.isArray(solarWindRaw) ? solarWindRaw.slice(1) : [];
  const latestWind   = windRecords.at(-1) ?? [];
  const windSpeed    = parseFloat(latestWind[2] ?? 0); // km/s
  const protonDensity = parseFloat(latestWind[1] ?? 0);

  // ── Active alerts ──
  const rawAlerts = Array.isArray(alertsRaw) ? alertsRaw : [];
  const activeAlerts = rawAlerts
    .filter(a => a.productCode && a.issuanceTime)
    .slice(0, 10)
    .map(a => ({
      code:    a.productCode,
      time:    a.issuanceTime,
      message: (a.message || '').substring(0, 300),
    }));

  // ── Signals ──
  const signals = [];

  if (currentKp >= 5) {
    signals.push({
      severity: kpSeverity(currentKp),
      signal:   `GEOMAGNETIC STORM Kp=${currentKp}: ${kpStormLabel(currentKp)} — RF/GPS degradation likely`,
    });
  }
  if (forecastPeak >= 6 && forecastPeak > currentKp) {
    signals.push({
      severity: kpSeverity(forecastPeak),
      signal:   `STORM INBOUND: Kp forecast peak=${forecastPeak} within next 24 h — ${kpStormLabel(forecastPeak)}`,
    });
  }
  if (currentFlux >= 1e-5) {
    signals.push({
      severity: xraySeverity(currentFlux),
      signal:   `SOLAR FLARE: ${xrayClass(currentFlux)} flux detected (${currentFlux.toExponential(2)} W/m²) — HF radio blackout possible`,
    });
  }
  if (windSpeed > 600) {
    signals.push({
      severity: 'high',
      signal:   `FAST SOLAR WIND: ${windSpeed.toFixed(0)} km/s solar wind speed — geomagnetic storm potential elevated`,
    });
  }
  if (activeAlerts.length > 0) {
    signals.push({
      severity: 'medium',
      signal:   `${activeAlerts.length} active NOAA SWPC alert(s): ${activeAlerts[0].code}`,
    });
  }

  // ── Events ──
  const events = [];

  if (currentKp >= 5) {
    events.push(makeEvent({
      id:          `kp-storm-${kpTime ?? Date.now()}`,
      type:        EVENT_TYPES.SDR_ANOMALY,
      timestamp:   kpTime ? new Date(kpTime).toISOString() : new Date().toISOString(),
      title:       `Geomagnetic Storm Kp=${currentKp} — ${kpStormLabel(currentKp)}`.substring(0, 120),
      description: `24h max Kp: ${maxKp24h}. Forecast peak: ${forecastPeak}. Solar wind: ${windSpeed.toFixed(0)} km/s, density ${protonDensity.toFixed(1)} p/cm³.`,
      severity:    kpSeverity(currentKp),
    }, SOURCE_NAME));
  }

  for (const alert of activeAlerts.slice(0, 5)) {
    events.push(makeEvent({
      id:          `swpc-${alert.code}-${alert.time}`,
      type:        EVENT_TYPES.SDR_ANOMALY,
      timestamp:   new Date(alert.time).toISOString(),
      title:       `NOAA SWPC: ${alert.code}`.substring(0, 120),
      description: alert.message.substring(0, 500),
      severity:    alert.code.includes('WATCH') ? 'high' : 'medium',
    }, SOURCE_NAME));
  }

  return {
    source:    SOURCE_NAME,
    timestamp: new Date().toISOString(),
    status:    'active',
    current: {
      kpIndex:        currentKp,
      kpStormLevel:   kpStormLabel(currentKp),
      kpMax24h:       maxKp24h,
      kpForecastPeak: forecastPeak,
      xrayFlux:       currentFlux,
      xrayClass:      xrayClass(currentFlux),
      solarWindSpeed: windSpeed,
      protonDensity,
      rfImpact: currentKp >= 5
        ? `DEGRADED — Kp=${currentKp} (${kpStormLabel(currentKp)})`
        : 'NOMINAL',
    },
    alerts:  activeAlerts,
    events,
    signals,
  };
}

// ─── SourceAdapter export ────────────────────────────────────────────────────

const spaceWeatherAdapter = createAdapter({
  name:           SOURCE_NAME,
  tier:           2,
  requiresApiKey: false,

  async fetch(ctx) { // eslint-disable-line no-unused-vars
    const result = await fetchSpaceWeather();
    return {
      source:    result.source,
      timestamp: result.timestamp,
      events:    result.events || [],
      summary:   result.current || {},
      signals:   (result.signals || []).map(s => s.signal),
      current:   result.current,
      alerts:    result.alerts,
      ...(result.error ? { error: result.error } : {}),
    };
  },
});

export default spaceWeatherAdapter;

// ─── Legacy briefing() ───────────────────────────────────────────────────────

export async function briefing() {
  return fetchSpaceWeather();
}

if (process.argv[1]?.endsWith('space-weather.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
