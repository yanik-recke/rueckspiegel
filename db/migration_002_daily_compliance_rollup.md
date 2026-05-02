# Migration 002 — `daily_compliance` rollup + helpers

Materializes per-day compliance into `daily_compliance` so the frontend stops paginating ~98k `price_changes` rows on every visit. Adds the SQL function `recompute_daily_compliance(target_date date)` (called by `load-prices` after each daily insert), a small `available_dates(n)` helper used by the day selector, and a composite index for the per-day query.

Run the whole block in the Supabase SQL editor. Re-running is safe (everything uses `IF NOT EXISTS` / `CREATE OR REPLACE`).

```sql
-- 1. Add latest-price columns so the rollup is self-sufficient for the map UI.
ALTER TABLE daily_compliance
  ADD COLUMN IF NOT EXISTS price_e5     INTEGER,
  ADD COLUMN IF NOT EXISTS price_e10    INTEGER,
  ADD COLUMN IF NOT EXISTS price_diesel INTEGER;

-- 2. Composite index for the frontend's per-day fetch.
CREATE INDEX IF NOT EXISTS daily_compliance_date_station_idx
  ON daily_compliance (date, station_id);

-- 3. Recompute function — peak-based E5 increase counting.
--    "Increase" = price_e5 strictly greater than both the previous non-null E5
--    AND the day's running peak (so a flicker that returns to an existing high
--    doesn't double-count). Rule: is_compliant = (increases_count <= 1).
CREATE OR REPLACE FUNCTION recompute_daily_compliance(target_date date)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  WITH day_rows AS (
    SELECT
      pc.station_id,
      pc.created_at,
      pc.id,
      pc.price_e5,
      pc.price_e10,
      pc.price_diesel
    FROM price_changes pc
    WHERE (pc.created_at AT TIME ZONE 'Europe/Berlin')::date = target_date
  ),
  e5_walk AS (
    SELECT
      station_id,
      created_at,
      price_e5,
      LAG(price_e5) OVER (
        PARTITION BY station_id ORDER BY created_at, id
      ) AS prev_e5,
      MAX(price_e5) OVER (
        PARTITION BY station_id ORDER BY created_at, id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS prev_high
    FROM day_rows
    WHERE price_e5 IS NOT NULL
  ),
  counted AS (
    SELECT station_id, created_at
    FROM e5_walk
    WHERE prev_e5 IS NOT NULL
      AND price_e5 > prev_e5
      AND (prev_high IS NULL OR price_e5 > prev_high)
  ),
  inc_agg AS (
    SELECT
      station_id,
      COUNT(*)::int  AS increases_count,
      MAX(created_at) AS last_inc_at
    FROM counted
    GROUP BY station_id
  ),
  last_e5 AS (
    SELECT DISTINCT ON (station_id) station_id, price_e5
    FROM day_rows
    WHERE price_e5 IS NOT NULL
    ORDER BY station_id, created_at DESC, id DESC
  ),
  last_e10 AS (
    SELECT DISTINCT ON (station_id) station_id, price_e10
    FROM day_rows
    WHERE price_e10 IS NOT NULL
    ORDER BY station_id, created_at DESC, id DESC
  ),
  last_diesel AS (
    SELECT DISTINCT ON (station_id) station_id, price_diesel
    FROM day_rows
    WHERE price_diesel IS NOT NULL
    ORDER BY station_id, created_at DESC, id DESC
  ),
  station_set AS (
    SELECT DISTINCT station_id FROM day_rows
  ),
  upsert AS (
    INSERT INTO daily_compliance (
      station_id, date, increases_count, last_increase_time, is_compliant,
      price_e5, price_e10, price_diesel
    )
    SELECT
      ss.station_id,
      target_date,
      COALESCE(ia.increases_count, 0),
      (ia.last_inc_at AT TIME ZONE 'Europe/Berlin')::time,
      COALESCE(ia.increases_count, 0) <= 1,
      le5.price_e5,
      le10.price_e10,
      ld.price_diesel
    FROM station_set ss
    LEFT JOIN inc_agg     ia   ON ia.station_id   = ss.station_id
    LEFT JOIN last_e5     le5  ON le5.station_id  = ss.station_id
    LEFT JOIN last_e10    le10 ON le10.station_id = ss.station_id
    LEFT JOIN last_diesel ld   ON ld.station_id   = ss.station_id
    ON CONFLICT (station_id, date) DO UPDATE SET
      increases_count    = EXCLUDED.increases_count,
      last_increase_time = EXCLUDED.last_increase_time,
      is_compliant       = EXCLUDED.is_compliant,
      price_e5           = EXCLUDED.price_e5,
      price_e10          = EXCLUDED.price_e10,
      price_diesel       = EXCLUDED.price_diesel
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO affected FROM upsert;

  RETURN affected;
END;
$$;

-- 4. Helper for the frontend day selector.
CREATE OR REPLACE FUNCTION available_dates(n integer DEFAULT 5)
RETURNS SETOF date
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT date
  FROM daily_compliance
  ORDER BY date DESC
  LIMIT n;
$$;
```

After applying, re-run `bun run load-prices --date YYYY-MM-DD` for any past dates you want to backfill. Each run will populate the rollup for that date.
