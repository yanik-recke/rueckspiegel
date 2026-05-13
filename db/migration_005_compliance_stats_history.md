# Migration 005 — `compliance_stats_history` aggregate table

Moves the stats-view source of truth off `daily_compliance` and onto a tiny
per-day aggregate table. Motivation: free-tier storage. `daily_compliance` is
~one row per station per day (~16k rows/day); the stats chart only needs a
single number per day. Persisting that aggregate separately means
`delete-date` can wipe `daily_compliance` (and `price_changes`) for old dates
without breaking the chart.

After this migration:

- `recompute_daily_compliance(target_date)` continues to populate
  `daily_compliance`, and additionally upserts one aggregate row into
  `compliance_stats_history` for that date.
- `compliance_stats_by_date(n)` reads from `compliance_stats_history` (cheap
  point read), not from `daily_compliance`.
- The frontend (`stats.ts`, `ComplianceStatRow`) is unchanged — the RPC name
  and return shape are identical.
- The operator script `ingestion/src/delete-date.ts` continues to delete
  `price_changes` + `daily_compliance` only; `compliance_stats_history` is
  retained indefinitely.

Run the whole block in the Supabase SQL editor. Re-running is safe — everything
uses `IF NOT EXISTS` / `CREATE OR REPLACE`. The backfill at the end uses
`ON CONFLICT … DO UPDATE` so it can also be re-run.

```sql
-- 1. Aggregate table — one row per date.
CREATE TABLE IF NOT EXISTS compliance_stats_history (
  stat_date           date PRIMARY KEY,
  non_compliant_count integer NOT NULL,
  total_stations      integer NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Anon read so the RPC (SECURITY INVOKER by default) can SELECT under RLS.
ALTER TABLE compliance_stats_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "compliance_stats_history read" ON compliance_stats_history;
CREATE POLICY "compliance_stats_history read"
  ON compliance_stats_history FOR SELECT
  TO anon, authenticated
  USING (true);

-- 2. Updated recompute — adds the history upsert at the end.
--    Guard: aggregate is computed off the just-written daily_compliance rows
--    for target_date. If that set is empty (e.g. post-cleanup, or no
--    price_changes ingested), HAVING COUNT(*) > 0 prevents zeroing out the
--    historical row. The history table is therefore append-only in practice,
--    except for legitimate same-day recomputes.
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
      pc.price_diesel
    FROM public.price_changes pc
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

  -- History rollup: aggregate the freshly-written daily_compliance rows for
  -- this date. Skipped entirely if the date has no rows (post-cleanup safety).
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

-- 3. Rewrite the RPC to read from the aggregate table.
CREATE OR REPLACE FUNCTION compliance_stats_by_date(n integer DEFAULT 30)
RETURNS TABLE(stat_date date, non_compliant_count bigint, total_stations bigint)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  SELECT stat_date,
         non_compliant_count::bigint,
         total_stations::bigint
  FROM (
    SELECT stat_date, non_compliant_count, total_stations
    FROM compliance_stats_history
    ORDER BY stat_date DESC
    LIMIT n
  ) recent
  ORDER BY stat_date ASC;
$$;

GRANT EXECUTE ON FUNCTION compliance_stats_by_date(integer) TO anon, authenticated;

-- 4. One-time backfill from existing daily_compliance. Idempotent.
INSERT INTO compliance_stats_history (
  stat_date, non_compliant_count, total_stations, updated_at
)
SELECT
  date,
  COUNT(*) FILTER (WHERE increases_count > 1)::int,
  COUNT(*)::int,
  now()
FROM daily_compliance
GROUP BY date
ON CONFLICT (stat_date) DO UPDATE SET
  non_compliant_count = EXCLUDED.non_compliant_count,
  total_stations      = EXCLUDED.total_stations,
  updated_at          = EXCLUDED.updated_at;
```

Smoke test:

```sql
-- Should match: one row per date currently in daily_compliance.
SELECT COUNT(DISTINCT date) FROM daily_compliance;
SELECT COUNT(*) FROM compliance_stats_history;

-- Should match: per-date non-compliant counts agree.
SELECT
  dc.date,
  COUNT(*) FILTER (WHERE dc.increases_count > 1) AS dc_non_compliant,
  csh.non_compliant_count                         AS csh_non_compliant
FROM daily_compliance dc
JOIN compliance_stats_history csh ON csh.stat_date = dc.date
GROUP BY dc.date, csh.non_compliant_count
HAVING COUNT(*) FILTER (WHERE dc.increases_count > 1) <> csh.non_compliant_count;
-- Expect: 0 rows.

-- RPC end-to-end.
SELECT * FROM compliance_stats_by_date(30);
```

## Operator notes

- `delete-date.ts` (in `ingestion/`) does **not** touch
  `compliance_stats_history`. Cleaning up an old date wipes `price_changes` +
  `daily_compliance`, but the stats chart keeps showing that date's counts.
- If you ever want to genuinely remove a date from the stats history (e.g.
  bad ingest data), `DELETE FROM compliance_stats_history WHERE stat_date = …`
  manually. There is no operator script for this on purpose — it should be
  rare and deliberate.
- Re-running `recompute_daily_compliance(target_date)` for a date where
  `daily_compliance` has been cleaned up is a no-op: the rollup CTE
  upserts nothing, and the history upsert's `HAVING COUNT(*) > 0` skips.
  The historical aggregate is preserved.
