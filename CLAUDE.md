# Rückspiegel — Project Notes for Future Claude Agents

A small webapp that tracks gas-station price-change compliance in Germany. German fuel-pricing rules effectively allow only one daily price increase, at 12:00 (Europe/Berlin). The app visualizes which stations follow the rule and which don't.

## Repository layout
```
db/                      SQL schema + mock data (markdown with embedded SQL)
  gas_station_schema.md  Tables: stations, price_changes, daily_compliance
  mock_data.md           Seed INSERTs for 3 stations + price history (2026-05-01)
frontend/                Vite + TS + MapLibre frontend (bun)
ingestion/               Bun + TS scripts that pull tankerkoenig data into Supabase
  src/lib.ts             Shared helpers: env, Berlin "yesterday", Basic-auth fetch (text/stream), logger, supabase client
  src/load-stations.ts   Fetches yesterday's stations CSV and upserts into `stations`
  src/load-prices.ts     Streams yesterday's prices CSV and upserts into `price_changes`
  README.md              Setup, env vars, CSV→DB column mapping, sample log output
```

## Stack decisions
- **Frontend:** Vite + TypeScript, MapLibre GL, OpenFreeMap Positron tiles (no API key), Supabase JS client. **Bun** is the package manager — use `bun install` / `bun run dev`, not npm.
- **Backend:** Supabase (Postgres + PostGIS + PostgREST + anon key model).
- **Mobile-first** dark UI; bottom sheet on mobile, side panel ≥768px. Safe-area insets respected.

## Data model essentials
- `stations.location` is `GEOGRAPHY(POINT, 4326)`. PostgREST returns it as **EWKB hex** — parsed client-side in `frontend/src/wkb.ts`.
- Prices stored as integers in tenths-of-cent (e.g. `1859` = €1.859). Frontend divides by 1000 for display.
- `daily_compliance` is the **frontend's primary data source for the map** (one row per `(station, date)`). Populated server-side by the SQL function `recompute_daily_compliance(target_date)` (defined in `db/migration_002_daily_compliance_rollup.md`), called at the end of each `load-prices` run. Holds `is_compliant`, `increases_count`, `last_increase_time`, plus latest non-null `price_e5/e10/diesel` for that day so the sheet doesn't need a second fetch. The `available_dates(n)` RPC returns the most recent N distinct dates for the day-selector pills. The per-station increase log shown in the sheet is **lazy-fetched on click** from `price_changes` for that station + date, then run through the same `computeCompliance` peak-based logic that the SQL function uses (kept in sync).

## Compliance rule (as implemented)
The MTSK rule allows one daily price increase, conventionally at noon. **In practice the price-event data we get from tankerkoenig is sparse** — many stations have only a handful of events per day, so we cannot pin the actual moment of an increase from `(prev_event, curr_event)` pairs. We therefore relax the rule:

- **0 or 1 E5 increase ⇒ compliant** (the one is assumed to be the allowed noon increase).
- **2+ E5 increases ⇒ non-compliant** (rule allows at most one).

An "increase" is **peak-based**: `price_e5` going up vs. the previous non-null reading **and** exceeding the day's previous high. This filters out MTSK flickers where a station bumps to a high, drops briefly, then returns to the same high — only the first step counts. A genuine second increase to a new high (e.g. noon to 2.10, afternoon to 2.15) still produces 2 increases. Null E5 rows are skipped (not treated as 0). See `computeCompliance` in `frontend/src/main.ts`. The noon check is still used to color which specific increases are flagged in the UI when a station has 2+ — non-noon ones get the violator badge first.

Why we relaxed: with sparse event data (often just 2–10 rows/day), we can't pin the timing of an increase to noon precisely; and MTSK regularly records flicker patterns that look like 2 events but represent one. The peak-based + "≤1 ⇒ compliant" combination matches the rule's intent ("the station never charged more than the daily allowed step up") and aligns with what ADAC appears to show.

## Frontend architecture
- `src/main.ts` — entry. Calls the `available_dates(5)` RPC for the day-selector, renders pills, defaults to the most recent. **Stations are loaded viewport-first**, not all-at-once: a debounced `moveend` handler calls the `stations_in_bbox(min_lng, min_lat, max_lng, max_lat, target_date)` RPC (defined in `db/migration_003_stations_in_bbox.md`) for the current map bounds (padded ~10%) whenever the user is zoomed at or above `minzoom = 8`. Below zoom 8 no fetch happens since dots aren't rendered anyway, so the cold-start of the app issues only the `available_dates` call. State is held in `stationsByDate: Map<date, Map<station_id, Station>>` so re-pans over loaded tiles don't refetch (covered-bbox check) and day switches reuse the per-date map. Per-station click triggers a small lazy fetch of `price_changes` for that station + date, runs `computeCompliance` (peak-based rule) on the result, and fills in the sheet's increase log via `setStationIncreases`.
- **List view (hamburger) lazy full-load.** The list panel needs every station for free-text search, so `mountList` accepts an `ensureLoaded` callback. The first time the user opens the list for a given date, `loadAllForDate(date)` runs the original paginated fetches (`stations` once, `daily_compliance` per date) and merges into the same `stationsByDate` map — the map view immediately benefits too. A "Lade Stationen…" placeholder with a spinner shows during the wait. `fullyLoadedDates: Set<date>` short-circuits subsequent opens; once a date is fully loaded, `moveend` skips its bbox fetches entirely.
- `src/map.ts` — MapLibre setup. Stations render as a single GeoJSON source + `circle` layer (`stations-circle`), data-driven color from `is_compliant` (green/red). `minzoom = 8` (re-exported as `STATIONS_MIN_ZOOM` so `main.ts` can gate bbox fetches by it); radius interpolates with zoom. Click handler attached to the layer (no per-marker DOM). Centers on Germany (`[10.4515, 51.1657]`, zoom 5.4). Also exports `getViewportBbox(map)` and a `Bbox` type used by the bbox loader.
- `src/sheet.ts` — info panel showing status badge, current prices (E5/E10/Diesel), and the day's price-increase log with violators flagged.
- `src/supabase.ts` — client + types (`StationRow`, `PriceChangeRow`, `Station`, `PriceIncrease`, `BboxStationRow`).
- `src/wkb.ts` — minimal EWKB-hex POINT parser (handles SRID flag + endianness). Used only by the lazy list-view full-load path; the bbox RPC returns numeric `lng`/`lat` directly so the map view never touches WKB.
- `src/i18n.ts` — DE/EN translation module. No third-party library. Exports `getLang`, `setLang`, `t`, `applyStaticTranslations`, `tTooManyResults`, `tResultCount`, `tIncreaseCountNote`. Language persists to `localStorage["ruckspiegel.lang.v1"]`; defaults to browser language (EN if `navigator.language` starts with "en", DE otherwise). `applyStaticTranslations()` walks `[data-i18n]`, `[data-i18n-placeholder]`, `[data-i18n-aria-label]` DOM attributes. A `#lang-toggle` button (between the list toggle and info toggle in the topbar) switches language in-place; `.subtitle` is hidden on mobile (`≤767px`) to avoid crowding. The Impressum and Datenschutzerklärung sections remain German-only.
- `src/stats.ts` — Stats overlay (full-screen slide-up panel) opened from the `#stats-toggle` topbar button. Calls the `compliance_stats_by_date(n)` RPC (default n=30, defined in `db/migration_004_compliance_stats_by_date.md`) and renders the per-day non-compliant station count as a Chart.js chart. A `.chart-type-switcher` (in `index.html`) lets the user pick between **bar**, **line**, and **dot** representations; the active button gets `chart-type-btn--active`. Chart.js is imported tree-shaken (`BarController`, `BarElement`, `LineController`, `LineElement`, `PointElement`, `CategoryScale`, `LinearScale`, `Tooltip`). The chart instance lives in the `mountStats()` closure and is updated in place on subsequent opens via `chart.data.* = …; chart.update()`; switching chart type destroys and recreates the chart (last rows are cached in `lastRows` so the switch doesn't re-fetch). The dot variant is a `line` chart with `showLine: false`. Opening also closes the list panel if it's open; selecting a different date in the day pill closes the stats panel (mirrors how the sheet behaves). The loading indicator is a `.stats-spinner` (reusing the `list-toggle-spin` keyframe). Bar/line/dot color is read once from the `--bad` CSS token via `getComputedStyle`; grid/tick colors are inlined hex/rgba (with the source token noted next to each).
- `src/styles.css` — design tokens at the top (`--bg`, `--surface`, `--accent`, `--bad`, etc.). Dark theme.

### Pagination + 1000-row cap
PostgREST caps any single `select` response at 1000 rows. `loadAllStationRows` and `loadComplianceForDate` in `main.ts` (used by the lazy full-load path triggered from the list view) loop `.range(from, from + 999)` until a short page comes back. Any new full-table fetch must paginate the same way — a plain `.select()` will silently truncate. The `stations_in_bbox` RPC is exempt — it returns at most a viewport's worth of rows, far below 1000 in practice.

### Day selector
`#day-selector` in the topbar holds the active-date pill plus a `…` more-button (rendered only when more than one date exists in `available_dates(5)`). Clicking `…` opens a `.day-popover` (`role="menu"`, anchored right) listing the other available dates with `DD.MM.` + a sublabel (`Heute` / `Gestern` / weekday short name). Selecting a date closes the popover, switches `activeDate`, reloads (or pulls from cache), and re-renders the map source. Outside-click or `Escape` closes the popover. The sheet hides on day switch — we don't carry station selection across days.

## Ingestion (`ingestion/`)
Bun + TypeScript scripts that pull tankerkoenig data into Supabase. Uses the **service-role key** server-side, so RLS doesn't apply.

**Why no git clone:** the upstream `tankerkoenig-data` repo is ~100 GB unpacked. Each script fetches just the CSV(s) it needs over HTTPS with Basic auth.

### Env (`ingestion/.env`, gitignored)
- `TK_USER` / `TK_PASS` — tankerkoenig data-portal credentials (Basic auth via `Authorization` header).
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — service-role key, never to be exposed to the frontend.

Scripts (run from `ingestion/`):
- `bun run load-stations` — refresh stations.
- `bun run load-prices` — ingest yesterday's price events.
- `bun run daily` — runs the two in order; this is the cron entry point. Stations must run first because `price_changes.station_id` has an FK to `stations.id`.

Recommended schedule: ~03:00 Europe/Berlin (yesterday's CSV is published by then). Scheduler choice (cron / GH Actions / Supabase scheduled function) is out of scope.

### `bun run load-stations`
- Fetches **yesterday's** stations CSV (Europe/Berlin — today's file usually doesn't exist yet) from
  `https://data.tankerkoenig.de/.../stations/YYYY/MM/YYYY-MM-DD-stations.csv`.
- Deletes the three mock-station UUIDs (`11111111-…`, `22222222-…`, `33333333-…`); `price_changes` cascade.
- Upserts into `public.stations` in batches of 1000 keyed on `id`.
- CSV → DB mapping:
  - `uuid` → `id`
  - `name` → `name`; `brand` → `brand` (empty → `null`)
  - `latitude`, `longitude` → `location` as `SRID=4326;POINT(lng lat)` EWKT (PostGIS accepts this directly for `GEOGRAPHY`).
  - `street + " " + house_number` → `street`; `post_code` truncated to 5 chars → `postcode`.
  - `city`, `first_active`, `openingtimes_json` are **ignored** (no DB columns).
- Skips rows missing `uuid`/`name` or with non-finite / `(0,0)` coords; skip counts logged as a single WARN line.
- Logging is `[+N.Ns]`-prefixed and reports fetch size+time, parse count, mock-delete count, and per-batch progress with rows/sec.

### `bun run load-prices [-- --date YYYY-MM-DD]`
- Default: yesterday in Europe/Berlin. Pass `--date YYYY-MM-DD` for backfill (e.g. `bun run load-prices -- --date 2026-04-27`).
- Streams the day's `prices/YYYY/MM/YYYY-MM-DD-prices.csv` (CSV columns: `date, station_uuid, diesel, e5, e10, dieselchange, e5change, e10change`).
- Change codes: `0=no change, 1=change, 2=removed (→ null), 3=new`.
- **Preflights** the full set of `stations.id` values into a `Set` before streaming (paginated 1000 at a time). Rows whose `station_uuid` isn't in the set are skipped in-stream and counted as `unknownStation` in the final log line. **This is critical**: without it, even one unknown FK in a 5000-row batch causes Postgres to roll back the whole batch — early testing showed ~80% of rows lost to this when ingesting before refreshing stations.
- Per row: skip if `station_uuid` unknown; skip if all three change codes are `0`; otherwise insert `{ station_id, created_at = date, price_e5/e10/diesel = round(value × 1000) }` (tenths-of-cent).
- Upserts in batches of 5000 with `onConflict: "station_id,created_at", ignoreDuplicates: true` — depends on the `UNIQUE (station_id, created_at)` constraint added by `db/migration_001_price_changes_unique.md`. Without that migration, reruns will double-insert.
- If the `stations` table is empty, exits with an error rather than silently producing an empty ingest.
- Uses streaming CSV parsing (`csv-parse`'s async iterator), so memory stays flat regardless of file size.
- After the insert phase, calls the Postgres RPC `recompute_daily_compliance(target_date)` to (re)populate `daily_compliance` for the ingested date. Logs the row count returned. The frontend reads from this rollup, never from raw `price_changes` for the map view.

## Supabase setup (must be done in dashboard for the frontend to work)
1. **Enable PostGIS:** `CREATE EXTENSION IF NOT EXISTS postgis;`
2. **Run schema** from `db/gas_station_schema.md`.
3. **Run migrations**: `db/migration_001_price_changes_unique.md`, `db/migration_002_daily_compliance_rollup.md`, `db/migration_003_stations_in_bbox.md` (the bbox RPC the frontend calls on `moveend`), `db/migration_004_compliance_stats_by_date.md` (the per-day rollup RPC the stats view chart uses).
4. **Seed mock data** from `db/mock_data.md`.
5. **Enable RLS** on all three tables, add `select` policies for `anon, authenticated using (true)`. No write policies — ingestion uses the service-role key (server-side only).
6. **Frontend `.env`** (in `frontend/`): copy from `.env.example`, fill `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Note: Supabase rebranded API keys — the **publishable / "default"** key (`sb_publishable_...`) is what goes in `VITE_SUPABASE_ANON_KEY`. The secret key never goes in any `VITE_*` variable.

## Conventions / preferences observed
- User wants **minimal, modern, mobile-first** UI — no over-engineering, no premature abstractions.
- German UI labels in the sheet. Wording is deliberately neutral/descriptive ("1 Preiserhöhung" / "Mehrere Preiserhöhungen", "An diesem Tag wurden N Preiserhöhungen erfasst") to avoid implying a station broke the law — observed sparse/flickery data could otherwise produce false accusations. The terms "Verstoß", "Konform", "Regel verletzt" must NOT appear in user-facing strings. Internal identifiers like `is_compliant`, `violates` may stay.
- First-visit disclaimer modal (`#disclaimer-modal`) gated by `localStorage["ruckspiegel.disclaimer.v1"]`. Same content is also permanently available in the info modal under "Hinweis zu den Daten".
- Comments are sparse; only used where the *why* is non-obvious (e.g. the schema-rule citation in `computeCompliance`).
- The frontend deliberately avoids depending on a custom Supabase RPC — earlier scaffold had `stations_with_status()` but it was dropped after the user asked to use the schema as-is.

## Open follow-ups (not yet done)
- Per-day non-compliant counts inside the day pills. Easy add now that the rollup exists — `available_dates` could be replaced by an RPC returning `(date, violator_count)`.
- Retention / cleanup of old `daily_compliance` rows beyond a window. ~16k rows/day is fine for years, but eventually worth a delete policy.
- Today's partial day. `load-prices` ingests yesterday's published file. If the user wants "today so far", we'd need to also pull the (live-updating) `today.csv` — separate ticket.
- No tests yet. Worth adding once shape stabilizes.

## Gotchas hit so far
- The harmless `WebGL warning: texImage: Alpha-premult and y-flip are deprecated` from MapLibre/Firefox can be ignored.
- PostGIS `GEOGRAPHY` columns over PostgREST come back as hex, not GeoJSON — hence the WKB parser.
- DST: do not check noon by adding `+2` to UTC hours. Use `Intl.DateTimeFormat` with `timeZone: "Europe/Berlin"`.
- PostGIS lives in the `extensions` schema on Supabase. Any PL/SQL function that does `SET search_path = ''` and references PostGIS (`geometry`, `ST_X`, `ST_MakeEnvelope`, the `&&` operator…) will fail with `type "geometry" does not exist`. Either include `extensions` on the path (`SET search_path = public, extensions`) or schema-qualify everything. See `db/migration_003_stations_in_bbox.md`.
