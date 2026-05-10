# Migration 004 — `compliance_stats_by_date` RPC

Adds a Postgres function the frontend's stats view calls on open to render a per-day
bar chart of how many stations recorded more than one price increase. Returns the N
most recent dates (default 30) in ascending order so the chart's x-axis reads
left-to-right oldest-to-newest.

The existing index `daily_compliance_date_station_idx` (added in migration 002) is
sufficient — the function only scans `daily_compliance` grouped by date.

Run in the Supabase SQL editor. Re-running is safe — `CREATE OR REPLACE` + idempotent
grants.

```sql
CREATE OR REPLACE FUNCTION compliance_stats_by_date(n integer DEFAULT 30)
RETURNS TABLE(stat_date date, non_compliant_count bigint, total_stations bigint)
LANGUAGE sql
STABLE
SET search_path = 'public'
AS $$
  WITH recent_dates AS (
    SELECT DISTINCT date
    FROM daily_compliance
    ORDER BY date DESC
    LIMIT n
  )
  SELECT
    dc.date              AS stat_date,
    COUNT(*) FILTER (WHERE dc.increases_count > 1) AS non_compliant_count,
    COUNT(*)             AS total_stations
  FROM daily_compliance dc
  WHERE dc.date IN (SELECT date FROM recent_dates)
  GROUP BY dc.date
  ORDER BY dc.date ASC;
$$;

GRANT EXECUTE ON FUNCTION compliance_stats_by_date(integer) TO anon, authenticated;
```

Smoke test:

```sql
SELECT * FROM compliance_stats_by_date(30);
```

Expect up to 30 rows, ordered ascending by `stat_date`, with `non_compliant_count`
matching the number of stations whose `increases_count > 1` for that day and
`total_stations` matching the row count in `daily_compliance` for that date.
