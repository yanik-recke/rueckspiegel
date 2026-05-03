# Diagnostic — why do many stations show 0 price increases?

Run these in the Supabase SQL editor. Replace `'2026-05-02'` with the date you want to inspect.

## 1. How often is `price_e5` null vs. populated for a given day?

If `null_e5` dominates while `has_e5` is small, the ingestion is dropping E5 values (likely the `value <= 0` branch in `toMilliEuros`).

```sql
SELECT
  COUNT(*) FILTER (WHERE price_e5 IS NULL)     AS null_e5,
  COUNT(*) FILTER (WHERE price_e5 IS NOT NULL) AS has_e5,
  COUNT(*) FILTER (WHERE price_e10 IS NULL)    AS null_e10,
  COUNT(*) FILTER (WHERE price_diesel IS NULL) AS null_diesel,
  COUNT(*) AS total_rows
FROM price_changes
WHERE (created_at AT TIME ZONE 'Europe/Berlin')::date = '2026-05-02';
```

```json
[
  {
    "null_e5": 1951,
    "has_e5": 126405,
    "null_e10": 5778,
    "null_diesel": 37,
    "total_rows": 128356
  }
]
```

## 2. Distribution of non-null E5 events per station

How many stations have 0, 1, 2-4, 5-10, 11+ non-null E5 rows that day. If most stations sit in the `0` or `1` bucket, the peak-based rule has nothing to count regardless.

```sql
SELECT bucket, COUNT(*) AS station_count FROM (
  SELECT
    CASE
      WHEN c = 0 THEN '0'
      WHEN c = 1 THEN '1'
      WHEN c BETWEEN 2 AND 4 THEN '2-4'
      WHEN c BETWEEN 5 AND 10 THEN '5-10'
      ELSE '11+'
    END AS bucket
  FROM (
    SELECT station_id, COUNT(*) FILTER (WHERE price_e5 IS NOT NULL) AS c
    FROM price_changes
    WHERE (created_at AT TIME ZONE 'Europe/Berlin')::date = '2026-05-02'
    GROUP BY station_id
  ) s
) t
GROUP BY bucket
ORDER BY bucket;
```

```json
[
  {
    "bucket": "0",
    "station_count": 314
  },
  {
    "bucket": "1",
    "station_count": 410
  },
  {
    "bucket": "11+",
    "station_count": 4238
  },
  {
    "bucket": "2-4",
    "station_count": 2388
  },
  {
    "bucket": "5-10",
    "station_count": 7211
  }
]
```

## 3. Cross-check: stations with 0 increases vs. how much E5 data they have

For all stations on that date, how many E5 readings did the rollup get to work with? Stations with `increases_count = 0` and `e5_rows >= 3` are the interesting ones — they had data, rule still found nothing.

```sql
SELECT
  dc.increases_count,
  COUNT(*) AS stations,
  AVG(stats.e5_rows)::numeric(10,2) AS avg_e5_rows,
  MIN(stats.e5_rows) AS min_e5_rows,
  MAX(stats.e5_rows) AS max_e5_rows
FROM daily_compliance dc
LEFT JOIN (
  SELECT station_id, COUNT(*) FILTER (WHERE price_e5 IS NOT NULL) AS e5_rows
  FROM price_changes
  WHERE (created_at AT TIME ZONE 'Europe/Berlin')::date = '2026-05-02'
  GROUP BY station_id
) stats ON stats.station_id = dc.station_id
WHERE dc.date = '2026-05-02'
GROUP BY dc.increases_count
ORDER BY dc.increases_count;
```

```json
[
  {
    "increases_count": 0,
    "stations": 7290,
    "avg_e5_rows": "6.77",
    "min_e5_rows": 0,
    "max_e5_rows": 33
  },
  {
    "increases_count": 1,
    "stations": 7266,
    "avg_e5_rows": "10.60",
    "min_e5_rows": 2,
    "max_e5_rows": 42
  },
  {
    "increases_count": 2,
    "stations": 4,
    "avg_e5_rows": "9.00",
    "min_e5_rows": 5,
    "max_e5_rows": 18
  },
  {
    "increases_count": 3,
    "stations": 1,
    "avg_e5_rows": "11.00",
    "min_e5_rows": 11,
    "max_e5_rows": 11
  }
]
```

## 4. Inspect a specific "0 increases" station's raw E5 series

Pick a station from query 3 that has `increases_count = 0` but plenty of E5 rows, drop its UUID in below, and read the trace by eye to see whether the peak-based rule was right to find nothing.

```sql
SELECT
  created_at AT TIME ZONE 'Europe/Berlin' AS berlin_ts,
  price_e5,
  price_e10,
  price_diesel
FROM price_changes
WHERE station_id = '<paste-uuid-here>'
  AND (created_at AT TIME ZONE 'Europe/Berlin')::date = '2026-05-02'
ORDER BY created_at, id;
```

__Did not do__

## 5. Sanity: how does E5-null rate correlate with change codes?

If we kept the original `e5change` codes we could check this directly, but we don't store them. Closest proxy — for rows where `price_e5 IS NULL` but `price_e10 IS NOT NULL` (i.e. an event happened, just not an E5 one), are we systematically missing the E5 baseline?

```sql
SELECT
  COUNT(*) FILTER (WHERE price_e5 IS NULL AND price_e10 IS NOT NULL) AS e5null_e10set,
  COUNT(*) FILTER (WHERE price_e5 IS NOT NULL AND price_e10 IS NULL) AS e5set_e10null,
  COUNT(*) FILTER (WHERE price_e5 IS NULL AND price_diesel IS NOT NULL) AS e5null_dieselset
FROM price_changes
WHERE (created_at AT TIME ZONE 'Europe/Berlin')::date = '2026-05-02';
```

```json
[
  {
    "e5null_e10set": 21,
    "e5set_e10null": 3848,
    "e5null_dieselset": 1949
  }
]
```

A high `e5null_e10set` count means most non-E5 events have us throwing away the E5 column — confirming `toMilliEuros` is the culprit.

## Findings (2026-05-02 dataset)

- E5 is populated on 98.5% of rows — `toMilliEuros` is **not** the bug.
- ~50% of stations show 0 increases despite avg 6.77 E5 rows; only 5 stations show 2+.
- The "0 increases" cohort has ~36% fewer E5 rows than the "1 increase" cohort, consistent with their first row of the day being the noon raise itself with no prior baseline to compare against.
- Root cause: the peak-based walk treated each station's first non-null E5 reading as a baseline, so a quiet-morning station's noon raise was silently swallowed.

Fix shipped in `migration_003_seed_prev_day_baseline.md` (server) + a symmetric change in `frontend/src/main.ts::computeCompliance` (client lazy fetch). Both now seed the walk from the prior day's `daily_compliance.price_e5`.

## 6. Verification — re-run after migration 003

After applying migration 003 and re-running `bun run load-prices -- --date 2026-05-02`, re-execute query 3. Expectation:

- "0 increases" cohort shrinks substantially (stations whose first row was their noon raise now have a prior-day baseline to compare against).
- "1 increase" cohort grows correspondingly.
- "2+ increases" cohort largely unchanged — truly non-compliant stations are unaffected.

Edge cases that still legitimately produce 0 increases:
- No prior-day rollup (first day after migration, gaps in cron, oldest backfilled date).
- Prior day's `daily_compliance.price_e5` is null (station had no E5 data yesterday).
- Today's first reading is ≤ yesterday's close (genuine drop or hold).
