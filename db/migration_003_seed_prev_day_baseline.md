# Migration 003 — seed prior-day E5 baseline into the increase walk

`recompute_daily_compliance()` previously treated each station's first non-null E5 reading of the day as a baseline, never as an increase. But the tankerkoenig CSV only contains *change events*, so a station with a quiet morning has its noon raise as the first row of the day — and that raise was being silently swallowed.

This migration replaces the function with one that pre-seeds the walk using the prior day's closing E5 price (already stored in `daily_compliance.price_e5`). When the prior day's row is missing or has a null price, the seed is skipped and behavior falls back to the previous logic (no regression).

Run in the Supabase SQL editor. Re-running is safe (`CREATE OR REPLACE`).

**Backfill order matters:** if you re-run historical dates, walk forward chronologically (oldest first) so each day's rollup has the prior day's rollup to lean on.

```sql
CREATE OR REPLACE FUNCTION recompute_daily_compliance(target_date date)
RETURNS integer
LANGUAGE plpgsql
SET search_path = ''
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
      pc.price_diesel,
      false AS is_seed
    FROM public.price_changes pc
    WHERE (pc.created_at AT TIME ZONE 'Europe/Berlin')::date = target_date
  ),
  -- Prior-day closing E5 per station, used as a synthetic pre-row so the
  -- window walk has a baseline for stations whose first event of the day
  -- is the noon raise itself.
  prev_day AS (
    SELECT station_id, price_e5
    FROM public.daily_compliance
    WHERE date = target_date - 1
      AND price_e5 IS NOT NULL
  ),
  seed_rows AS (
    SELECT
      pd.station_id,
      -- created_at must sort strictly before any real row of target_date.
      -- LAG/MAX windows only require non-null + correct ordering; the value
      -- itself is never read downstream.
      (target_date - 1)::timestamp AT TIME ZONE 'Europe/Berlin' AS created_at,
      (-1)::bigint AS id,
      pd.price_e5,
      NULL::integer AS price_e10,
      NULL::integer AS price_diesel,
      true AS is_seed
    FROM prev_day pd
    -- Only seed stations that actually have rows today (otherwise we'd
    -- conjure compliance entries for stations with no data on target_date).
    WHERE EXISTS (
      SELECT 1 FROM day_rows dr WHERE dr.station_id = pd.station_id
    )
  ),
  walk_input AS (
    SELECT * FROM day_rows
    UNION ALL
    SELECT * FROM seed_rows
  ),
  e5_walk AS (
    SELECT
      station_id,
      created_at,
      price_e5,
      is_seed,
      LAG(price_e5) OVER (
        PARTITION BY station_id ORDER BY created_at, id
      ) AS prev_e5,
      MAX(price_e5) OVER (
        PARTITION BY station_id ORDER BY created_at, id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS prev_high
    FROM walk_input
    WHERE price_e5 IS NOT NULL
  ),
  counted AS (
    SELECT station_id, created_at
    FROM e5_walk
    WHERE NOT is_seed
      AND prev_e5 IS NOT NULL
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
    INSERT INTO public.daily_compliance (
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
```

After applying, re-run `bun run load-prices -- --date YYYY-MM-DD` for any date you want to retroactively fix. Each run will recompute that day's rollup using the new logic. The very first day after this migration won't benefit (no prior-day rollup yet); every day after that will.
