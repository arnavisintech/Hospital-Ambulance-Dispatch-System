# HADS: Hospital Ambulance Dispatch System

HADS dispatches ambulances based at partner hospitals ("dark stations") to emergencies. A requester sends an SOS from
the app, or a controller enters a phone call. The dispatch engine offers the request to the ambulance with the shortest
road-time ETA, checks bed, ICU and specialist capacity at nearby hospitals before confirming a destination, and tracks
the trip until the patient is handed over. Completed trips feed a demand model, which uses incident history, households
and age groups to predict where the next emergencies will come from.

Pilot city: Chennai. Requirements are traced in [`docs/TRACEABILITY.md`](docs/TRACEABILITY.md).

| Role | Uses HADS to |
|---|---|
| Requester | Raise an SOS in one or two taps, track the ambulance live, share a link with family, see the trip history, export or delete their data |
| Ambulance crew | Go on duty, accept or reject offers, follow turn-by-turn routes, report status and GPS |
| Hospital staff | Keep bed/ICU/specialist capacity current, receive incoming patients, confirm handovers, manage their own fleet, search trip records, export station history (PDF), record payments, see predicted demand nearby |
| Controller | Watch the live board, resolve escalations, assign manually, enter phone (IVR) requests, act on rebalancing advice |
| Admin | Onboard and verify hospitals, stations and ambulances; manage users, settings, billing and claims; import population data; issue API keys for 108/102 centres; read the audit log |
| City health authority | Read-only city overview: response times, coverage gaps, compliance and equity reports, audit log |

## Architecture

```
 browser / installed PWA ──▶ nginx (frontend container): SPA, security headers, TLS, cached map tiles
                               │ /api, websocket
                               ▼
                       FastAPI backend (one instance)
                       ├─ dispatch engine (severity-ordered, one routed ranking call per request)
                       ├─ capacity matching, trips, billing, notifications, audit chain
                       ├─ demand model (scikit-learn) + rebalancing
                       └─ background workers: offer timeouts + dispatch sweep, model refresh, retention
                               │                         │
                     PostgreSQL 16 (WAL archived)     OSRM (Chennai road graph; falls back to
                     + nightly base backups           straight-line estimates if unavailable)
```

- **Backend:** Python 3.12, FastAPI, SQLAlchemy 2, Alembic, scikit-learn, fpdf2. Code in `backend/app`, tests in `backend/tests`.
- **Frontend:** React 18, TypeScript, Vite, Tailwind, Leaflet. Code in `frontend/src`, tests in `frontend/src/test`.
- **Database:** PostgreSQL 16 in production; SQLite (WAL) for a single machine without Docker.
- **Realtime:** websockets with single-use tickets; durable in-app notifications.

**Topology constraint:** run exactly **one backend instance**. Rate limits, the dispatch lock and websocket fan-out
live in that process. Scale it vertically.

## Quick start: demo

The demo has a seeded Chennai city, simulated ambulances, and a one-click login for every role.

**With Docker** (Docker Desktop running):

```bat
start-demo.bat
```

It runs `docker compose --env-file demo.env -f docker-compose.yml -f docker-compose.demo.yml up -d --build` and opens
http://localhost:8080. The first start downloads and prepares the Chennai road graph, which takes a few minutes; until
then routing uses straight-line estimates.

**Without Docker** (Python 3.12+ and Node 22):

```powershell
.\scripts\run-local.ps1          # demo on SQLite: http://localhost:4173
.\scripts\run-local.ps1 -Reset   # start again from fresh demo data
.\scripts\run-local.ps1 -NoDemo  # empty database
```

For real road routes without the full Docker stack, start only the router first (it reuses the prepared Chennai
road graph): `docker compose --env-file demo.env -f docker-compose.yml -f docker-compose.dev.yml up -d osrm`.
`run-local.ps1` uses it when it answers; otherwise routes are straight-line estimates, drawn dashed and labelled as
approximate.

The demo accounts are listed on the sign-in page. Dispatch sends each call to whichever hospital and ambulance suit it
best, so the Hospital and Crew cards have a dropdown: pick the hospital or ambulance shown on the trip to receive the
patient or drive the trip. Their password is published, so **never** use demo mode for real patients (production
refuses to start in demo mode).

## Production

1. Copy `.env.example` to `.env` and fill it in. Generate secrets with `python backend/scripts/gen_keys.py`.
   Required: `POSTGRES_PASSWORD`, `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, `CORS_ORIGINS`. Set `BOOTSTRAP_ADMIN_EMAIL`
   and `BOOTSTRAP_ADMIN_PASSWORD` for the first admin, who must change the password at first sign-in.
2. HTTPS: put `fullchain.pem` and `privkey.pem` in `./certs`. nginx then serves 443 with HSTS and redirects 80.
   For testing, `scripts/make-cert.ps1` or `scripts/make-cert.sh` makes a self-signed pair.
3. `docker compose up -d --build`. The backend container migrates the schema before it starts.
4. Sign in as the bootstrap admin, change the password, then onboard hospitals (they must be verified before they
   receive patients), stations and ambulances, and create staff accounts. Without Docker, create an admin with
   `python backend/scripts/create_admin.py`.

Only the web front end is published (ports 80/443). The API, database and router are reachable only inside the Compose
network. Day-to-day operation, backups, restore and monitoring: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).
Security model and DPDP: [`docs/SECURITY.md`](docs/SECURITY.md). Per-role guide: [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md).

## Configuration

All settings are environment variables. Uppercase names map to `backend/app/config.py`.

| Variable | Default | Purpose |
|---|---|---|
| `APP_ENV` | `development` | `production` refuses unsafe settings; `demo` enables the demo city and logins |
| `DATABASE_URL` | `sqlite:///./data/hads.db` | `postgresql+psycopg2://...` in production (Compose sets it) |
| `JWT_SECRET`, `JWT_EXPIRE_MINUTES` | (dev only), 720 | Session tokens; production requires 32+ random characters |
| `DATA_ENCRYPTION_KEY` | (none) | Fernet key(s), comma separated, the first encrypts; required in production |
| `CORS_ORIGINS` | `*` | Explicit origins in production |
| `SERVICE_AREA`, `CITY_LAT`, `CITY_LNG` | Chennai | Service-area bounding box and map centre; another city is a configuration change |
| `ROUTING_PROVIDER`, `OSRM_URL` | `haversine` | `osrm` in Compose; falls back automatically when OSRM is slow (over 1.5 s) or down |
| `GEO_PROVIDER` | `offline` | Built-in Chennai gazetteer; `nominatim` is a third-party service and off by default |
| `API_THREADS`, `DB_POOL_SIZE`, `DB_MAX_OVERFLOW` | 40, 20, 40 | Concurrency limits; connections must be at least threads + 10 |
| `LOG_JSON` | false (true in Compose) | One JSON object per log line, with request IDs |
| `GPS_RETENTION_HOURS`, `NOTIFICATION_RETENTION_DAYS` | 24, 30 | Data minimisation |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | (none) | First admin, created only when no users exist |
| `DEMO_MODE`, `DEMO_AUTOPILOT`, `SEED_ON_STARTUP` | false | Demo only; rejected in production |
| `AUTO_CREATE_SCHEMA` | false | Tests and throwaway databases only; deployments run `scripts/migrate.py` |
| `BACKUP_DIR`, `BACKUP_KEEP`, `BACKUP_INTERVAL_H` | volume, 7, 24 | Database backups (Compose `backup` service) |
| `STADIA_API_KEY` | (none) | Map-tile key, needed on a real domain (tiles are the only external runtime dependency) |

Platform parameters such as fares, revenue share, dispatch and response targets, crew acknowledgement timeout and the
capacity freshness window are edited in the admin Settings page, not in the environment.

## Development

```sh
cd backend && python -m venv .venv && .venv/Scripts/pip install -r requirements.txt   # Linux/macOS: .venv/bin/
.venv/Scripts/python -m pytest -q                       # backend tests (SQLite)
../scripts/test-postgres.ps1                            # the same suite on PostgreSQL 16 (Docker)
cd ../frontend && npm ci
npx vitest run && npx tsc --noEmit && npx eslint src --max-warnings 0 && npm run build
```

- **Schema changes:** edit `backend/app/models.py`, run `alembic revision --autogenerate -m "..."`, review the file.
  `tests/test_migrations.py` fails if the models and migrations drift apart.
- **API changes:** run `python backend/scripts/export_openapi.py`. `tests/test_openapi_current.py` keeps
  [`docs/openapi.json`](docs/openapi.json) current, and that file is the API contract.
- **UI:** use the components in `frontend/src/components/ui` and the tokens in
  [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md). `theme.test.ts` and `contrast.test.ts` enforce them.

## Known limitations

These are deliberate scope decisions; HADS does not claim them.

- **No cloud or high availability.** One host and one backend instance. The 99.9 % uptime target (NFR2) depends on that
  host and is not proven here. Backups, point-in-time restore and restart policies are provided; automatic failover to
  a second host is not.
- **"Live traffic" is a time-of-day congestion factor** applied to OSRM's free-flow road times, not a live traffic feed.
- **No SMS or push notifications.** Notifications are in-app, delivered live over websockets and kept for offline devices.
- **No payment gateway or insurer integration.** Hospital staff record payments; insurance claims are tracked internally.
- **The IVR path is operator data entry.** There is no telephony line.
- **The 108/102 interface is a neutral API** ([`docs/INTEROP.md`](docs/INTEROP.md)) that a government system must be
  configured to call.
- **Population data is a synthetic estimate** until an admin imports real census figures (Settings → Demographics).
  The app labels it as such wherever it is shown.
- **Crew GPS is reported while the app is open.** A web app cannot report location in the background.
- **Map tiles** come from Stadia Maps (or OpenStreetMap as a fallback). They are the only external runtime dependency.
