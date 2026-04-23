# Whoop MCP Server

A Model Context Protocol (MCP) server that connects your Whoop health data to Claude. Designed to be hosted remotely and used as a custom connector in Claude.ai.

Built using the [Whoop Developer API v2](https://developer.whoop.com/docs/introduction).

## Features

- **Recovery Data**: Daily recovery scores, HRV, resting heart rate, SpO2, skin temperature, calibration flag
- **Sleep Analysis**: Sleep duration, stages, efficiency, performance, respiratory rate, sleep cycles, disturbances
- **Sleep Debt Model**: Baseline + accumulated debt + strain-driven need, nap-adjusted, no-data-corrected
- **Strain Tracking**: Daily strain scores, calories burned, heart rate zones
- **Workout Detail**: Every captured v2 workout field — sport, duration, strain, HR, zones (ms + %), distance, elevation, % recorded, timezone, score state, record timestamps
- **Training Readiness**: Green/yellow/red verdict from today's recovery, 3-day HRV vs 30-day baseline, RHR drift, sleep shortfall, and recent strain
- **Training Load Correlation**: Day-by-day strain joined with next-day recovery and HRV, stratified by high-vs-low strain days
- **Profile & Body**: Height, weight, Whoop-estimated max heart rate
- **Auto-Sync**: Smart sync on every query, full 90-day initial pull, 7-day quick refresh thereafter
- **90-Day History**: Local SQLite cache (encrypted tokens) for trend analysis and fast queries

## MCP Tools

### Daily briefing
| Tool | Arguments | Description |
|------|-----------|-------------|
| `get_today` | — | Morning briefing: recovery (+ SpO2, skin temp), last night's sleep (+ cycles, disturbances), current strain |
| `get_readiness_brief` | — | Training readiness verdict. Combines current recovery, 3-day HRV vs 30-day baseline, RHR drift, sleep shortfall, and yesterday's strain into green/yellow/red with reasons |

### Trends
| Tool | Arguments | Description |
|------|-----------|-------------|
| `get_recovery_trends` | `days` (1–90, default 14) | Recovery/HRV/RHR trend with averages |
| `get_sleep_analysis` | `days` (1–90, default 14) | Sleep duration/performance/efficiency trend |
| `get_strain_history` | `days` (1–90, default 14) | Daily strain + calories |
| `get_sleep_debt` | `days` (1–90, default 14) | Per-night actual vs need (baseline + carried debt + strain − nap), shortfall, disturbances, cycles |
| `get_training_load` | `days` (1–90, default 14) | Daily strain joined with next-day recovery/HRV, high-vs-low strain recovery stratification |

### Workout detail
| Tool | Arguments | Description |
|------|-----------|-------------|
| `get_workouts` | `days` (1–90, default 14), `min_strain` (number, optional) | Every captured workout field per session: id, sport, start/end + TZ, duration, strain, HR, zones ms + %, distance, elevation, % recorded, score state, record timestamps |

### Nutrition & activity (Apple Health via Health Auto Export)
| Tool | Arguments | Description |
|------|-----------|-------------|
| `get_nutrition_today` | — | Today's macros (kcal/protein/carbs/fat with %-of-kcal, fat subtypes, fiber, sugar) + micros (Na, K, Ca, Fe, cholesterol, vitamin C) and individual energy entries. Auto-converts kJ → kcal |
| `get_nutrition_trend` | `days` (1–90, default 14) | Daily macro rollup with averages |
| `get_energy_balance` | `days` (1–90, default 14) | Whoop kcal burned vs Apple Health kcal consumed, joined by cycle time-window. Shows deficit/surplus and protein per kg bodyweight |
| `get_energy_expenditure` | `days` (1–90, default 14) | Basal (BMR) + active kcal from Apple Health alongside Whoop cycle kcal, with Apple − Whoop delta |
| `get_daily_activity` | `days` (1–90, default 14) | Steps, walking distance, flights climbed — NEAT signal that complements `get_training_load` |
| `get_gait_metrics` | `days` (1–90, default 14) | Walking speed, step length, asymmetry %, double-support %. Injury-prevention signal |

### Garmin (via local push script, requires GARMIN_PUSH_TOKEN)
| Tool | Arguments | Description |
|------|-----------|-------------|
| `get_body_composition` | `days` (1–90, default 30) | Body composition trend from the Garmin Index scale: weight, BMI, body fat %, muscle mass, bone mass, body water %. Rolling 7/30-day averages and week-over-week delta. Data is pushed by `scripts/garmin_push.py` run locally — see below |

**Why local push instead of server pull?** Garmin's SSO sits behind Cloudflare which bot-blocks requests from big cloud provider IP ranges (Railway included). Running a small script on your laptop sidesteps that entirely. The server just accepts JSON over HTTPS.

**Setup:**

```bash
python3 -m venv scripts/.venv
source scripts/.venv/bin/activate
pip install garminconnect requests

GARMIN_EMAIL=you@example.com \
GARMIN_PASSWORD='...' \
GARMIN_PUSH_TOKEN='matches-server-env-var' \
python3 scripts/garmin_push.py
```

Run it whenever you weigh in, or schedule it via cron / launchd / systemd.

### Account
| Tool | Arguments | Description |
|------|-----------|-------------|
| `get_profile` | — | Live profile + body measurements (height, weight, max HR) |
| `sync_data` | `full` (bool, default false) | Manually trigger a data sync; `full=true` forces a 90-day resync |
| `get_auth_url` | — | Get authorization URL for first-time Whoop connection |

## Setup

### 1. Create a Whoop Developer App

1. Go to [developer.whoop.com](https://developer.whoop.com)
2. Create a new application
3. Note your **Client ID** and **Client Secret**
4. Set the redirect URI to your deployed server's callback URL (e.g., `https://your-app.railway.app/callback`)

### 2. Deploy to Railway

1. Fork/push this repo to GitHub
2. Create a new project on [Railway](https://railway.app)
3. Connect your GitHub repo
4. Add environment variables:
   - `WHOOP_CLIENT_ID`: Your Whoop app client ID
   - `WHOOP_CLIENT_SECRET`: Your Whoop app client secret
   - `WHOOP_REDIRECT_URI`: `https://your-app.railway.app/callback`
5. Add a volume mounted at `/data` for persistent SQLite storage
6. Deploy!

### 3. Authorize with Whoop

1. Visit `https://your-app.railway.app/health` to verify it's running
2. The first time you use the `get_auth_url` tool in Claude, it will provide an authorization link
3. Visit the link, log in to Whoop, and authorize the app
4. You'll be redirected back and the initial 90-day sync will begin

### 4. Connect to Claude

1. Go to Claude.ai settings → Connectors
2. Click "Add custom connector"
3. Enter:
   - **Name**: Whoop
   - **Remote MCP server URL**: `https://your-app.railway.app/mcp`
4. Use it in any chat!

## Local Development

```bash
# Install dependencies
npm install

# Create .env file
cat > .env << EOF
WHOOP_CLIENT_ID=your_client_id
WHOOP_CLIENT_SECRET=your_client_secret
WHOOP_REDIRECT_URI=http://localhost:3000/callback
MCP_MODE=http
EOF

# Run in development mode
npm run dev
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WHOOP_CLIENT_ID` | Whoop OAuth client ID | Required |
| `WHOOP_CLIENT_SECRET` | Whoop OAuth client secret | Required |
| `WHOOP_REDIRECT_URI` | OAuth callback URL | `http://localhost:3000/callback` |
| `ENCRYPTION_SECRET` | Key-derivation secret for token-at-rest encryption | Falls back to `WHOOP_CLIENT_SECRET` |
| `HEALTHKIT_TOKEN` | Bearer token required on `POST /healthkit` from Health Auto Export | Optional; unset = endpoint returns 503 |
| `GARMIN_PUSH_TOKEN` | Bearer token required on `POST /garmin/body-composition` from the local `garmin_push.py` script | Optional; unset = endpoint returns 503 |
| `DB_PATH` | SQLite database path | `./whoop.db` |
| `PORT` | HTTP server port | `3000` |
| `MCP_MODE` | `http` for remote, `stdio` for local | `http` |

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Whoop MCP Server                   │
│                                                 │
│  ┌─────────────┐      ┌──────────────────┐    │
│  │ MCP Server  │◄────►│  SQLite Database │    │
│  │ (HTTP)      │      │  - cycles        │    │
│  └─────────────┘      │  - recovery      │    │
│         │             │  - sleep         │    │
│         │             │  - workouts      │    │
│         ▼             │  - tokens        │    │
│  ┌─────────────┐      └──────────────────┘    │
│  │ Whoop API   │                               │
│  │ Client      │                               │
│  └─────────────┘                               │
└─────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────┐
│  Claude.ai (Custom Connector)                   │
│  "Hey, what's my recovery today?"               │
└─────────────────────────────────────────────────┘
```

## API Endpoints Used

This server uses the following Whoop API v2 endpoints:

- `GET /v2/user/profile/basic` - User profile
- `GET /v2/user/measurement/body` - Body measurements
- `GET /v2/cycle` - Physiological cycles (strain data)
- `GET /v2/recovery` - Recovery scores
- `GET /v2/activity/sleep` - Sleep records
- `GET /v2/activity/workout` - Workout records

## License

MIT - See [LICENSE](LICENSE) for details.
