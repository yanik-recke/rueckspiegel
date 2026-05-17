# Migration 006 — apply prior-day E5 seed to the recompute function (with history rollup)

Migration 003 (prior-day E5 seed in `recompute_daily_compliance`) was never applied to the live database — migration 005 was applied directly on top of 002 and overwrote the function without picking up 003's seed logic. As a result the rollup has been counting an extra increase whenever a station's first event of the day is a drop or a partial recovery that stays below the previous day's close.

Concrete example caught on 2026-05-16, station `6f5d2ce4-3047-47ed-85e0-c4ef4818b293` "Agroservice Altenburg-":

- Prior-day E5 close: 2049
- Day series: 1939 → 1989 → 1989 → 2089
- Without seed: the 1939→1989 step counts (no prior baseline to clamp it), plus 1989→2089. **2 increases → red.**
- With seed=2049: 1989 < day-high(2049), so only 1989→2089 counts. **1 increase → green.** Matches the client-side `computeCompliance` in `frontend/src/main.ts`, which is the trustworthy reference.

This migration re-issues `recompute_daily_compliance` with both 003's seed CTE *and* 005's history upsert, then backfills every date currently in `daily_compliance` chronologically so each day benefits from the prior day's seed.

Run the whole block in the Supabase SQL editor. Re-running is safe (`CREATE OR REPLACE`, `ON CONFLICT … DO UPDATE`).

```sql
-- 1. Merged function: 003's seed walk + 005's history rollup.
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
  prev_day AS (
    SELECT station_id, price_e5
    FROM public.daily_compliance
    WHERE date = target_date - 1
      AND price_e5 IS NOT NULL
  ),
  seed_rows AS (
    SELECT
      pd.station_id,
      (target_date - 1)::timestamp AT TIME ZONE 'Europe/Berlin' AS created_at,
      (-1)::bigint AS id,
      pd.price_e5,
      NULL::integer AS price_e10,
      NULL::integer AS price_diesel,
      true AS is_seed
    FROM prev_day pd
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

  INSERT INTO public.compliance_stats_history (
    stat_date, non_compliant_count, total_stations, updated_at
  )
  SELECT
    target_date,
    COUNT(*) FILTER (WHERE increases_count > 1)::int,
    COUNT(*)::int,
    now()
  FROM public.daily_compliance
  WHERE date = target_date
  HAVING COUNT(*) > 0
  ON CONFLICT (stat_date) DO UPDATE SET
    non_compliant_count = EXCLUDED.non_compliant_count,
    total_stations      = EXCLUDED.total_stations,
    updated_at          = EXCLUDED.updated_at;

  RETURN affected;
END;
$$;

-- 2. Backfill every date already in daily_compliance, oldest first, so each
--    day's recompute can see the prior day's freshly-seeded close.
DO $$
DECLARE
  d date;
BEGIN
  FOR d IN SELECT DISTINCT date FROM daily_compliance ORDER BY date ASC LOOP
    PERFORM recompute_daily_compliance(d);
  END LOOP;
END $$;
```

Verification — the Agroservice Altenburg- case from the bug report should flip:

```sql
SELECT increases_count, is_compliant, last_increase_time, price_e5
FROM daily_compliance
WHERE station_id = '6f5d2ce4-3047-47ed-85e0-c4ef4818b293'
  AND date = '2026-05-16';
-- Expect: increases_count = 1, is_compliant = true
```
