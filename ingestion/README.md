# Rückspiegel — Ingestion

Pulls fuel-station data from the [tankerkoenig-data](https://data.tankerkoenig.de) git repository and writes it into the Supabase Postgres backend used by the frontend.

The historic repo is ~100 GB unpacked, so we **don't clone it**. Each script fetches just the CSV(s) it needs over HTTPS with Basic auth.

## Setup

```bash
cd ingestion
bun install
cp .env.example .env
# fill in TK_PASS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
```

`.env` variables:

| Var                         | What                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| `TK_USER`                   | Tankerkönig data-portal username (your registered email).            |
| `TK_PASS`                   | Tankerkönig data-portal password.                                    |
| `SUPABASE_URL`              | Project URL, e.g. `https://xxxx.supabase.co`.                        |
| `SUPABASE_SERVICE_ROLE_KEY` | **Service-role** key (server-side only — never ship this anywhere).  |

The service-role key bypasses RLS, which is what we want for ingestion. Keep it out of any `VITE_*` env file.

## Scripts

| Script              | What                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `bun run load-stations` | Refresh `stations` from yesterday's stations CSV.                  |
| `bun run load-prices`   | Ingest yesterday's price-change events into `price_changes`.       |
| `bun run daily`         | `load-stations` then `load-prices` — the cron entry point.         |
| `bun run delete-date`   | Dump-then-delete `price_changes` + `daily_compliance` for given date(s). |

Recommended schedule: ~03:00 Europe/Berlin so yesterday's CSV is definitely published. Scheduler (cron / GH Actions / Supabase scheduled function) is out of scope.

### `load-stations`

```bash
bun run load-stations
```

Fetches **yesterday's** stations CSV (Europe/Berlin — today's file usually doesn't exist yet) from:

```
https://data.tankerkoenig.de/tankerkoenig-organization/tankerkoenig-data/raw/branch/master/stations/YYYY/MM/YYYY-MM-DD-stations.csv
```

Then:

1. Deletes the three mock-station UUIDs (`11111111-…`, `22222222-…`, `33333333-…`) if present. `price_changes` cascade with them.
2. Upserts every CSV row into `public.stations` in batches of 1000, keyed on `id`.

CSV → DB column mapping:

| CSV                                | DB                                       |
| ---------------------------------- | ---------------------------------------- |
| `uuid`                             | `id`                                     |
| `name`                             | `name`                                   |
| `brand`                            | `brand` (empty → `null`)                 |
| `latitude`, `longitude`            | `location` (`SRID=4326;POINT(lng lat)`)  |
| `street` + `house_number`          | `street` (joined with a space)           |
| `post_code`                        | `postcode` (truncated to 5 chars)        |
| `city`, `first_active`, `openingtimes_json` | *(ignored — no DB columns)*     |

Rows missing `uuid`, `name`, or with non-finite / `(0,0)` coordinates are skipped and counted in the log.

### Logging

Every line is timestamped with seconds since process start, e.g.:

```
[+ 0.0s] source date: 2026-05-01 (Europe/Berlin, yesterday)
[+ 0.0s] GET https://data.tankerkoenig.de/.../stations/2026/05/2026-05-01-stations.csv
[+ 1.4s] fetched 2103.6 KB in 1380ms
[+ 1.6s] parsed 16,142 CSV rows
[+ 1.6s] WARN skipped 7 rows (noUuid=0, noName=2, badCoords=5)
[+ 1.6s] prepared 16,135 valid records
[+ 1.7s] removed 3 mock station(s)
[+ 1.7s] upserting in 17 batch(es) of 1000…
[+ 2.3s] batch 1/17: +1000 (1000/16135, 1666 rows/s)
…
[+12.8s] upsert complete: 16135 rows in 11.1s
[+12.8s] done in 12.8s
```

Errors are logged with stack traces and exit with code `1`.

### `load-prices`

```bash
bun run load-prices                       # yesterday (Europe/Berlin)
bun run load-prices -- --date 2026-04-27  # specific date (backfill)
```

Fetches the day's prices CSV from:

```
https://data.tankerkoenig.de/tankerkoenig-organization/tankerkoenig-data/raw/branch/master/prices/YYYY/MM/YYYY-MM-DD-prices.csv
```

CSV columns: `date, station_uuid, diesel, e5, e10, dieselchange, e5change, e10change`. Change codes: `0=no change, 1=change, 2=removed, 3=new`.

Per row:
- Skip if all three change codes are `0` (no real movement).
- For each fuel: change `2` → `null`; otherwise multiply euros by 1000 and round to int tenths-of-cent.
- Skip the row if `station_uuid` or `date` is missing, or all three prices end up null.

Upserts in batches of 5000 with `onConflict: "station_id,created_at", ignoreDuplicates: true`.

> **Requires migrations 001 and 002.** This script depends on:
> - `UNIQUE (station_id, created_at)` on `price_changes` (`db/migration_001_price_changes_unique.md`) — without it, reruns double-insert.
> - The `recompute_daily_compliance(target_date)` SQL function (`db/migration_002_daily_compliance_rollup.md`) — called at the end of every run to (re)populate `daily_compliance` for the ingested date. Without it, the post-insert step fails and the frontend sees empty rollup data.

Foreign-key violations (`23503`, "station not found") are logged as a WARN per affected batch but don't abort the run. If you see them, run `load-stations` first (or just use `bun run daily`).

Streaming CSV parser (`csv-parse` async iterator), so the daily file is processed as it arrives — memory stays flat.

### Deleting a past date

Use when you need to drop all price data for one or more historical dates (e.g. to free up space or remove a corrupted ingest).

```bash
# Remove a single date
bun run delete-date -- --date 2026-04-01

# Remove multiple dates
bun run delete-date -- --date 2026-03-01 --date 2026-03-02

# Write dump files to a custom directory (default: ./dumps)
bun run delete-date -- --date 2026-04-01 --dump-dir /backups/ruckspiegel
```

**What is deleted:** every `price_changes` row whose `created_at` falls inside the date's UTC day, and every `daily_compliance` row whose `date` equals the given date. The `stations` table is **never** touched.

**Dump file (safety net):** before any delete, the script writes a SQL file named `dump_YYYY-MM-DD_<unix-ms>.sql` to the dump directory (`./dumps/` by default). It contains `BEGIN; … COMMIT;` with batched `INSERT … ON CONFLICT DO NOTHING` statements for both tables — restore with:

```bash
psql "$DATABASE_URL" -f ./dumps/dump_2026-04-01_<ts>.sql
```

If the dump cannot be written, **no rows are deleted** for that date. Deletion order is `daily_compliance` (derived) before `price_changes` (source of truth), so a failure between the two leaves the raw events intact.

There is no interactive confirmation prompt — the dump file is the safety mechanism, and the script is intended to be cron-friendly.

## Roadmap

- Have `load-prices` (or a sibling script) also pull the **partial day-of** prices file so users can see "today so far" without waiting until tomorrow's ingestion.
- A built-in multi-date backfill wrapper. Currently you loop `--date` calls in your shell.
