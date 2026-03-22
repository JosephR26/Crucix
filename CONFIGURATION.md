# Crucix — Configuration Reference

All configuration lives in two places:
1. **`crucix.config.mjs`** — structured config object, reads from env vars
2. **`.env`** (or environment) — raw key/value overrides (copy from `.env.example`)

---

## Server

| Env Var | Config Key | Default | Notes |
|---------|-----------|---------|-------|
| `PORT` | `config.port` | `3117` | HTTP port for dashboard + API |
| `REFRESH_INTERVAL_MINUTES` | `config.refreshIntervalMinutes` | `15` | Sweep cadence in minutes |

---

## Data Sources

### No-key sources (always active)
GDELT, WHO, OFAC, OpenSanctions, ReliefWeb, Safecast, NOAA, EPA, Treasury, GSCPI, USAspending, Comtrade, Bluesky, Reddit, Telegram (public channels), KiwiSDR, Space, CISA-KEV, OpenSky, ADS-B Exchange, YFinance.

### Keyed sources

| Source | Env Var(s) | Where to get it | Notes |
|--------|-----------|----------------|-------|
| FRED (economic data) | `FRED_API_KEY` | fred.stlouisfed.org/docs/api | Free, instant |
| NASA FIRMS (fires) | `FIRMS_MAP_KEY` | firms.modaps.eosdis.nasa.gov/api | Free |
| EIA (energy prices) | `EIA_API_KEY` | api.eia.gov/register | Free |
| Maritime AIS | `AISSTREAM_API_KEY` | aisstream.io | Free tier available |
| ACLED (conflict events) | `ACLED_EMAIL` + `ACLED_PASSWORD` | acleddata.com/register | Free academic/research |
| Cloudflare Radar | `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → API Tokens → Account Analytics Read | Free |
| BLS (labor stats) | `BLS_API_KEY` | api.bls.gov/registrationEngine | Free |

---

## LLM Layer

Enables AI-generated trade ideas and smart alert narratives for Telegram/Discord.

| Env Var | Config Key | Notes |
|---------|-----------|-------|
| `LLM_PROVIDER` | `config.llm.provider` | `anthropic` / `openai` / `gemini` / `codex` / `openrouter` / `minimax` / `mistral` / `ollama` |
| `LLM_API_KEY` | `config.llm.apiKey` | Not needed for `codex` (uses `~/.codex/auth.json`) or `ollama` (local) |
| `LLM_MODEL` | `config.llm.model` | Optional override. Defaults: anthropic→`claude-sonnet-4-6`, openai→`gpt-4o`, gemini→`gemini-1.5-pro`, ollama→`llama3.1:8b` |
| `OLLAMA_BASE_URL` | `config.llm.baseUrl` | Default: `http://localhost:11434` |

**Without an LLM:** Ideas are disabled (`ideasSource: 'disabled'`), but all OSINT sweeps and delta computation still work. Telegram/Discord alerts fall back to rule-based messages.

---

## Telegram Alerts

| Env Var | Config Key | Notes |
|---------|-----------|-------|
| `TELEGRAM_BOT_TOKEN` | `config.telegram.botToken` | Create via @BotFather |
| `TELEGRAM_CHAT_ID` | `config.telegram.chatId` | Your chat/group ID (get via @userinfobot) |
| `TELEGRAM_POLL_INTERVAL` | `config.telegram.botPollingInterval` | Milliseconds between bot polls. Default: `5000` |
| `TELEGRAM_CHANNELS` | `config.telegram.channels` | Comma-separated extra channel IDs to monitor |

**Bot commands:** `/status`, `/sweep` (manual trigger), `/brief` (current snapshot), `/portfolio`

---

## Discord Alerts

| Env Var | Config Key | Notes |
|---------|-----------|-------|
| `DISCORD_BOT_TOKEN` | `config.discord.botToken` | Full bot with slash commands |
| `DISCORD_CHANNEL_ID` | `config.discord.channelId` | Channel to post alerts |
| `DISCORD_GUILD_ID` | `config.discord.guildId` | Server ID for instant slash command registration |
| `DISCORD_WEBHOOK_URL` | `config.discord.webhookUrl` | Webhook-only mode (simpler; no bot needed) |

Discord has two modes: **full bot** (requires `DISCORD_BOT_TOKEN` + `DISCORD_CHANNEL_ID`) and **webhook-only** (`DISCORD_WEBHOOK_URL`). The bot mode enables slash commands; webhook mode only sends outbound alerts.

---

## Delta Engine Thresholds

Customize sensitivity in `crucix.config.mjs` under `config.delta.thresholds`. Overrides only apply to specified keys; others use defaults from `lib/delta/engine.mjs`.

```js
// crucix.config.mjs
delta: {
  thresholds: {
    numeric: {
      vix: 3,        // flag VIX moves >= 3% (default: 5%)
      wti: 5,        // flag WTI moves >= 5% (default: 3%)
    },
    count: {
      urgent_posts: 5,  // need 5+ new urgent posts to flag (default: 2)
    },
  },
},
```

### Default numeric thresholds (% change to trigger signal)

| Key | Default | Metric |
|-----|---------|--------|
| `vix` | 5% | CBOE VIX |
| `hy_spread` | 5% | High-yield credit spread |
| `10y2y` | 10% | 10Y–2Y yield curve |
| `wti` | 3% | WTI crude oil |
| `brent` | 3% | Brent crude |
| `natgas` | 5% | Natural gas |
| `unemployment` | 2% | US unemployment rate |
| `fed_funds` | 1% | Fed funds rate |
| `10y_yield` | 3% | 10-year Treasury yield |
| `usd_index` | 1% | USD trade-weighted index |
| `mortgage` | 2% | 30-year mortgage rate |

### Default count thresholds (absolute change to trigger signal)

| Key | Default | Metric |
|-----|---------|--------|
| `urgent_posts` | ±2 | Urgent OSINT Telegram posts |
| `thermal_total` | ±500 | NASA FIRMS thermal detections |
| `air_total` | ±50 | Aircraft in monitored airspace |
| `who_alerts` | ±1 | WHO health alerts |
| `conflict_events` | ±5 | ACLED conflict events |
| `conflict_fatalities` | ±10 | ACLED reported fatalities |
| `sdr_online` | ±3 | KiwiSDR receivers online |
| `news_count` | ±5 | GDELT news items |
| `sources_ok` | ±1 | Data sources responding |

---

## Analysis Modules

Custom correlation/analysis modules are registered in `src/analysis/registry.mjs`. Each module receives delta events after each sweep.

```js
// src/analysis/registry.mjs
import { myModule } from './jobs/my-module.mjs';
registry.register(myModule);
```

Results are served at `GET /api/analysis`. See [src/analysis/types.mjs](src/analysis/types.mjs) for the interface.

---

## Storage Layout

```
runs/
├── latest.json          # Raw output of most recent fullBriefing() sweep
└── memory/
    ├── hot.json         # Last 3 synthesized runs + deltas (atomic writes)
    ├── hot.json.bak     # Previous hot.json (crash recovery)
    └── cold/
        └── YYYY-MM-DD.json   # Archived older runs by date
```

Run `npm run clean` to wipe all cached data and start fresh.
