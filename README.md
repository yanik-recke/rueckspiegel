# Rückspiegel

Live: **<https://rueckspiegel.net>**

A small webapp that visualises whether German gas stations stick to the [federal price-transparency rule](https://www.bundesregierung.de/breg-en/news/measures-against-petrol-prices-2412504): one daily price increase, conventionally at noon (Europe/Berlin). Stations that look like they bumped their E5 price more than once on a given day are flagged in red on the map; the rest are green.

Don't expect frequent maintenance or updates — this is a hobby project. Contributions welcome.

> **Note on the rule.** Tankerkönig's published change events are sparse (often only a handful of rows per station per day), so the app uses a relaxed *peak-based* rule rather than trying to pin the moment of the increase to noon: a station is flagged only when its E5 price ratchets up to a **new daily high more than once**. Small flickers (drop + return to the same high) don't count. This errs on the side of *not* accusing stations falsely. See `CLAUDE.md` for the full rationale.

## How it works

```
┌──────────────────┐      ┌────────────────────────────┐      ┌─────────────────────┐
│ tankerkoenig CSV │ ───▶ │ ingestion/ (Bun + TS)       │ ───▶ │ Supabase (Postgres) │
│ (daily snapshot) │      │  load-stations, load-prices │      │  + PostGIS + RLS    │
└──────────────────┘      └────────────────────────────┘      └──────────┬──────────┘
                                                                          │ anon key
                                                                          ▼
                                                              ┌─────────────────────┐
                                                              │ frontend/ (Vite)     │
                                                              │ MapLibre + Supabase  │
                                                              └─────────────────────┘
```

- **`db/`** — SQL schema, mock data, and migrations (markdown with embedded SQL blocks; paste into the Supabase SQL editor).
- **`ingestion/`** — Bun + TypeScript scripts that pull yesterday's tankerkoenig CSVs over HTTPS Basic auth and upsert into Supabase using the service-role key. Designed to run from cron at ~03:00 Europe/Berlin.
- **`frontend/`** — Vite + TypeScript + MapLibre GL. Loads stations viewport-first via a `stations_in_bbox` Postgres RPC; the hamburger list view lazy-loads the full set on first open.

## Getting started

Prereqs: [Bun](https://bun.sh) and a Supabase project.

### 1. Database

In the Supabase SQL editor, run in order:
1. `CREATE EXTENSION IF NOT EXISTS postgis;`
2. `db/gas_station_schema.md`
3. `db/migration_001_price_changes_unique.md`
4. `db/migration_002_daily_compliance_rollup.md`
5. `db/migration_003_stations_in_bbox.md`
6. (Optional) `db/mock_data.md` for three fictional stations + a day of price events.
7. Enable RLS on all three tables and add `select` policies for `anon, authenticated using (true)`. No write policies — ingestion uses the service-role key server-side.

### 2. Frontend

```bash
cd frontend
cp .env.example .env   # fill VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (publishable key, sb_publishable_…)
bun install
bun run dev
```

### 3. Ingestion (optional — only if you want fresh data, not just the mock seed)

You'll need credentials for the [tankerkoenig data portal](https://creativecommons.tankerkoenig.de/) (free, request access).

```bash
cd ingestion
cp .env.example .env   # fill TK_USER, TK_PASS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
bun install
bun run daily          # refreshes stations, then ingests yesterday's prices
```

`bun run load-prices -- --date YYYY-MM-DD` backfills any past day. See `ingestion/README.md` for details.

## Stack

- **Frontend:** Vite, TypeScript, MapLibre GL, [OpenFreeMap](https://openfreemap.org) Positron tiles, `@supabase/supabase-js`. Bun as package manager.
- **Backend:** Supabase (Postgres + PostGIS + PostgREST + anon key model).
- **Ingestion:** Bun, TypeScript, streaming CSV via `csv-parse`.

## Data sources & licenses

- Fuel-price data: [Tankerkönig](https://creativecommons.tankerkoenig.de/) — CC BY 4.0, attribution required.
- Map data: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors — ODbL, attribution required.
- Map tiles & style: [OpenFreeMap](https://openfreemap.org) (Positron, MIT-licensed).

Attribution for all three is shown in-app (corner control + the "Hinweis zu den Daten" section of the info modal).

## License

MIT — see `LICENSE`.

## Further reading

`CLAUDE.md` in the repo root is the long-form architecture doc: data model, the relaxed compliance rule and why, frontend architecture, ingestion pipeline, gotchas. Worth reading before opening a non-trivial PR.
