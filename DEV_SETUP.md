# Crucix — Local Development Setup

A self-hosted intelligence terminal pulling 29 global OSINT, economic, and cyber sources.

---

## Quick Start (Node)

### Prerequisites
- Node.js >= 22 (`node --version`)
- npm >= 10

### Steps

```bash
git clone https://github.com/YOUR_FORK/Crucix.git
cd Crucix
npm install

# Copy and edit environment variables
cp .env.example .env
# At minimum, no keys are required — most sources work without auth.
# Add keys for premium sources as needed (see CONFIGURATION.md).

npm start
# Dashboard opens at http://localhost:3117
# Health check: http://localhost:3117/api/health
```

The first sweep runs immediately on startup (~30 s). The dashboard shows a loading screen until data arrives.

---

## Quick Start (Docker)

```bash
docker compose up
```

Or build manually:

```bash
docker build -t crucix .
docker run -p 3117:3117 --env-file .env crucix
```

### Docker Compose with persistent runs/ storage

`docker-compose.yml` mounts `./runs` as a volume so sweep data survives restarts. Edit the file to add your env vars or reference an env file.

---

## Environment Variables

Copy `.env.example` to `.env`. All variables are optional; sources degrade gracefully when keys are missing.

| Variable | Default | Required for |
|----------|---------|-------------|
| `PORT` | `3117` | Server port |
| `REFRESH_INTERVAL_MINUTES` | `15` | Sweep cadence |
| `FRED_API_KEY` | — | FRED economic data (free at fred.stlouisfed.org) |
| `FIRMS_MAP_KEY` | — | NASA FIRMS fire data (free at firms.modaps.eosdis.nasa.gov/api) |
| `EIA_API_KEY` | — | Energy Information Administration (free at api.eia.gov/register) |
| `AISSTREAM_API_KEY` | — | Maritime AIS ship tracking (aisstream.io) |
| `ACLED_EMAIL` + `ACLED_PASSWORD` | — | Conflict event data (acleddata.com) |
| `CLOUDFLARE_API_TOKEN` | — | Internet outage data (Cloudflare Radar) |
| `LLM_PROVIDER` | — | `anthropic` / `openai` / `gemini` / `ollama` / others |
| `LLM_API_KEY` | — | API key for chosen LLM provider |
| `LLM_MODEL` | (provider default) | Override model name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local Ollama endpoint |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot alerts |
| `TELEGRAM_CHAT_ID` | — | Target Telegram chat |
| `DISCORD_BOT_TOKEN` | — | Discord bot |
| `DISCORD_CHANNEL_ID` | — | Discord channel to post alerts |
| `DISCORD_WEBHOOK_URL` | — | Discord webhook (simpler alternative to bot) |

---

## Minimal Demo-Friendly Config

To run with **zero API keys** and only public/unauthenticated sources:

```env
PORT=3117
REFRESH_INTERVAL_MINUTES=30
```

This activates ~20 of 29 sources automatically (GDELT, WHO, OFAC, ReliefWeb, Safecast, KiwiSDR, NOAA, EPA, Patents, Bluesky, Reddit, Telegram public channels, Space, CISA-KEV, Treasury, GSCPI, USAspending, OpenSky, ADS-B, YFinance). Sources without valid keys skip gracefully and report in `meta.sourcesFailed`.

---

## Enabling / Disabling Sources

Sources are wired in `apis/briefing.mjs`. To disable a specific source temporarily without deleting code, comment out its `runSource(...)` call in `fullBriefing()`:

```js
// runSource('FIRMS', firms),   // <-- disabled
```

For a more surgical approach, the `SourceAdapter` pattern (see [docs/SOURCE_TEMPLATE.md](docs/SOURCE_TEMPLATE.md)) allows per-source enable/disable flags in config.

---

## Adding New Sources

See [docs/SOURCE_TEMPLATE.md](docs/SOURCE_TEMPLATE.md) for the full adapter interface.

Short version:
1. Create `apis/sources/my-source.mjs` implementing the `SourceAdapter` contract.
2. Import and add a `runSource('MySource', mySource)` call in `apis/briefing.mjs`.
3. Map the new data key in `dashboard/inject.mjs::synthesize()` to surface it in the UI.

---

## Useful Scripts

| Command | What it does |
|---------|-------------|
| `npm start` | Start server (production-style) |
| `npm run dev` | Start with `--trace-warnings` for extra debug output |
| `npm run sweep` | Run a single sweep and print JSON (no server) |
| `npm run diag` | Diagnostics — check which sources are reachable |
| `npm run clean` | Delete `runs/` directory to reset all cached data |
| `npm run fresh-start` | Clean then restart |
| `npm run lint` | Check code style (ESLint) |
| `npm run format` | Auto-format code (Prettier) |

---

## Health Check

```
GET http://localhost:3117/api/health
```

Returns:

```json
{
  "status": "ok",
  "uptime": 3620,
  "lastSweep": "2026-03-22T12:00:00.000Z",
  "nextSweep": "2026-03-22T12:15:00.000Z",
  "sweepInProgress": false,
  "sourcesOk": 24,
  "sourcesFailed": 5,
  "llmEnabled": false,
  "refreshIntervalMinutes": 15
}
```

Use this for uptime monitors, Docker `HEALTHCHECK`, or your own dashboards.

---

## Analysis Layer (Custom Correlation)

After each sweep, Crucix can run your own analysis modules. Place them in `src/analysis/` following the `AnalysisJob` interface (see [src/analysis/types.mjs](src/analysis/types.mjs)). Results are exposed at:

```
GET http://localhost:3117/api/analysis
```

---

## Project Structure

```
Crucix/
├── server.mjs              # Main entrypoint: Express + sweep loop + SSE
├── crucix.config.mjs       # All config knobs (env overrides)
├── apis/
│   ├── briefing.mjs        # Orchestrates all 29 sources in parallel
│   ├── sources/            # One file per data source
│   └── utils/              # fetch.mjs, env.mjs
├── lib/
│   ├── delta/              # Delta engine + memory manager
│   ├── llm/                # LLM provider abstraction (8 providers)
│   └── alerts/             # Telegram + Discord alerters
├── src/
│   ├── adapters/           # SourceAdapter interface
│   └── analysis/           # Analysis job registry (your correlation logic)
├── dashboard/
│   ├── inject.mjs          # Synthesizes raw data → dashboard format
│   └── public/             # jarvis.html (globe + panels), loading.html
├── docs/                   # SOURCE_TEMPLATE.md and other docs
├── runs/                   # Runtime data (gitignored)
│   ├── latest.json         # Last full sweep output
│   └── memory/             # Delta memory (hot.json, cold/)
└── locales/                # i18n strings (en.json, fr.json)
```
