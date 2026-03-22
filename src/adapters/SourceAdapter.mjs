/**
 * Crucix SourceAdapter — interface contract for all OSINT data source modules.
 *
 * Every source must export a default object (or class instance) conforming to
 * this interface. The briefing orchestrator calls `adapter.fetch(ctx)` and wraps
 * the result in the standard runSource() envelope.
 *
 * Design decisions:
 * - Plain objects are preferred over classes to keep modules stateless and
 *   easy to tree-shake.
 * - The `ctx` argument gives adapters access to config + the last sweep cursor
 *   without importing global state, making them independently testable.
 * - Normalized events share a common schema so the analysis layer can process
 *   events from any source without source-specific branching.
 */

// ─── Types (JSDoc) ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} SourceContext
 * @property {Object}  config          - Full crucix config object
 * @property {string}  [cursor]        - ISO timestamp of last successful sweep
 *                                       (allows incremental/delta fetches)
 * @property {string}  [apiKey]        - Primary API key for this source (if any)
 * @property {Object}  [extra]         - Source-specific extra params from config
 */

/**
 * @typedef {Object} NormalizedEvent
 * @property {string}  id              - Stable unique identifier (e.g. CVE ID, flight ICAO+ts, ACLED event ID)
 * @property {string}  type            - Event category (see EVENT_TYPES below)
 * @property {string}  source          - Source adapter name, e.g. 'CISA-KEV'
 * @property {string}  timestamp       - ISO 8601 timestamp of the event itself
 * @property {string}  [title]         - Short human-readable summary (< 120 chars)
 * @property {string}  [description]   - Longer detail (< 500 chars)
 * @property {'low'|'medium'|'high'|'critical'} severity - Signal severity
 * @property {GeoPoint} [geo]          - Geographic coordinates if applicable
 * @property {AssetIds} [assets]       - Network/cyber asset identifiers
 * @property {Object}  [raw]           - Original upstream data (omit from storage)
 */

/**
 * @typedef {Object} GeoPoint
 * @property {number} lat
 * @property {number} lon
 * @property {string} [label]          - Human-readable place name
 */

/**
 * @typedef {Object} AssetIds
 * @property {string[]} [ips]          - IP addresses
 * @property {string[]} [domains]      - Hostnames / FQDNs
 * @property {string[]} [asns]         - AS numbers (e.g. 'AS15169')
 * @property {string[]} [cves]         - CVE identifiers
 * @property {string[]} [iocs]         - Generic indicators of compromise
 */

/**
 * @typedef {Object} SourceResult
 * @property {string}         source   - Adapter name
 * @property {string}         timestamp - ISO timestamp of this fetch
 * @property {NormalizedEvent[]} events - Normalized events from this sweep
 * @property {Object}         summary  - Source-specific aggregate metrics
 *                                       (counts, totals, etc.)
 * @property {string[]}       [signals] - Pre-computed human-readable alert strings
 * @property {string}         [error]  - Error message if fetch partially/fully failed
 */

// ─── Event Type Vocabulary ───────────────────────────────────────────────────

export const EVENT_TYPES = {
  // Cyber / infrastructure
  VULN_EXPLOITED: 'vuln.exploited',
  INTERNET_OUTAGE: 'internet.outage',
  TRAFFIC_ANOMALY: 'traffic.anomaly',

  // Geopolitical / conflict
  CONFLICT_EVENT: 'conflict.event',
  SANCTIONS_ADDED: 'sanctions.added',
  HEALTH_ALERT: 'health.alert',
  HUMANITARIAN: 'humanitarian.event',

  // Environmental / physical
  FIRE_DETECTION: 'fire.detection',
  RADIATION_ANOMALY: 'radiation.anomaly',
  WEATHER_SEVERE: 'weather.severe',

  // Signals / RF
  SDR_ANOMALY: 'sdr.anomaly',

  // Air / maritime / space
  AIRCRAFT: 'aircraft.tracked',
  VESSEL: 'vessel.tracked',
  SATELLITE_EVENT: 'satellite.event',

  // Economic / financial
  ECONOMIC_INDICATOR: 'economic.indicator',
  MARKET_SIGNAL: 'market.signal',

  // Social / open source
  OSINT_POST: 'osint.post',
  NEWS_ITEM: 'news.item',
};

// ─── Interface Definition ────────────────────────────────────────────────────

/**
 * SourceAdapter interface.
 *
 * Implement this as a plain object literal (recommended) or a class.
 * Export it as the default export from your source module.
 *
 * @example
 * // apis/sources/my-source.mjs
 * import { createAdapter } from '../../src/adapters/SourceAdapter.mjs';
 * export default createAdapter({ name: 'MySource', fetch: async (ctx) => { ... } });
 *
 * // For backwards compatibility, also export the legacy `briefing` function:
 * export async function briefing() { return myAdapter.fetch({}); }
 */
export const ADAPTER_INTERFACE = {
  /**
   * Unique display name for this source (used in logs, UI, delta keys).
   * @type {string}
   */
  name: '',

  /**
   * Tier classification — controls sweep order and priority in UI.
   * @type {1|2|3|4|5|6}
   */
  tier: 1,

  /**
   * Whether this adapter requires an API key to function.
   * When true, it should degrade gracefully (return empty events) when
   * ctx.apiKey is absent rather than throwing.
   * @type {boolean}
   */
  requiresApiKey: false,

  /**
   * Fetch data from the upstream source.
   *
   * @param {SourceContext} ctx
   * @returns {Promise<SourceResult>}
   */
  fetch: async (ctx) => { // eslint-disable-line no-unused-vars
    throw new Error('SourceAdapter.fetch() must be implemented');
  },
};

// ─── Factory Helper ──────────────────────────────────────────────────────────

/**
 * Merge a partial adapter definition with the interface defaults.
 * Validates required fields at definition time.
 *
 * @param {Partial<typeof ADAPTER_INTERFACE>} definition
 * @returns {typeof ADAPTER_INTERFACE}
 */
export function createAdapter(definition) {
  if (!definition.name) throw new Error('SourceAdapter requires a name');
  if (typeof definition.fetch !== 'function') throw new Error(`SourceAdapter '${definition.name}' requires a fetch() function`);
  return { ...ADAPTER_INTERFACE, ...definition };
}

/**
 * Build a minimal NormalizedEvent with required fields filled in.
 *
 * @param {Partial<NormalizedEvent>} fields
 * @param {string} sourceName
 * @returns {NormalizedEvent}
 */
export function makeEvent(fields, sourceName) {
  return {
    id: fields.id || `${sourceName}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type: fields.type || EVENT_TYPES.NEWS_ITEM,
    source: sourceName,
    timestamp: fields.timestamp || new Date().toISOString(),
    severity: fields.severity || 'low',
    ...fields,
  };
}
