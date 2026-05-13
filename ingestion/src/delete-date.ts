import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { log, requireSupabase } from "./lib";

type Args = {
  dates: string[];
  dumpDir: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const dates: string[] = [];
  let dumpDir = "./dumps";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") {
      const value = argv[++i];
      if (!value) {
        console.error("[fatal] --date requires a value (YYYY-MM-DD)");
        process.exit(1);
      }
      dates.push(value);
    } else if (a === "--dump-dir") {
      const value = argv[++i];
      if (!value) {
        console.error("[fatal] --dump-dir requires a value");
        process.exit(1);
      }
      dumpDir = value;
    } else {
      console.error(`[fatal] unknown argument: ${a}`);
      printUsage();
      process.exit(1);
    }
  }

  if (dates.length === 0) {
    console.error("[fatal] at least one --date YYYY-MM-DD is required");
    printUsage();
    process.exit(1);
  }

  for (const d of dates) {
    if (!isValidDate(d)) {
      console.error(`[fatal] invalid date: ${d} (expected YYYY-MM-DD calendar date)`);
      process.exit(1);
    }
  }

  return { dates, dumpDir };
}

function printUsage(): void {
  console.error(
    "usage: bun run delete-date -- --date YYYY-MM-DD [--date YYYY-MM-DD ...] [--dump-dir PATH]",
  );
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

function nextDayUtc(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function sqlVal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return `'${v.toISOString().replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

type PriceRow = {
  station_id: string;
  price_e5: number | null;
  price_e10: number | null;
  price_diesel: number | null;
  created_at: string;
};

type ComplianceRow = {
  station_id: string;
  date: string;
  increases_count: number | null;
  last_increase_time: string | null;
  is_compliant: boolean | null;
  price_e5: number | null;
  price_e10: number | null;
  price_diesel: number | null;
};

async function dumpPriceChanges(
  supabase: SupabaseClient,
  date: string,
  nextDay: string,
  fd: number,
): Promise<number> {
  const PAGE = 1000;
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("price_changes")
      .select("station_id, price_e5, price_e10, price_diesel, created_at")
      .gte("created_at", date)
      .lt("created_at", nextDay)
      .order("created_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch price_changes failed: ${error.message}`);
    const rows = (data ?? []) as PriceRow[];
    if (rows.length === 0) break;

    const values = rows
      .map(
        (r) =>
          `  (${sqlVal(r.station_id)}, ${sqlVal(r.price_e5)}, ${sqlVal(r.price_e10)}, ${sqlVal(
            r.price_diesel,
          )}, ${sqlVal(r.created_at)})`,
      )
      .join(",\n");

    const stmt =
      "INSERT INTO public.price_changes\n" +
      "  (station_id, price_e5, price_e10, price_diesel, created_at) VALUES\n" +
      values +
      "\nON CONFLICT (station_id, created_at) DO NOTHING;\n\n";
    writeSync(fd, stmt);

    total += rows.length;
    if (rows.length < PAGE) break;
  }
  return total;
}

async function dumpDailyCompliance(
  supabase: SupabaseClient,
  date: string,
  fd: number,
): Promise<number> {
  const PAGE = 1000;
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("daily_compliance")
      .select(
        "station_id, date, increases_count, last_increase_time, is_compliant, price_e5, price_e10, price_diesel",
      )
      .eq("date", date)
      .order("station_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch daily_compliance failed: ${error.message}`);
    const rows = (data ?? []) as ComplianceRow[];
    if (rows.length === 0) break;

    const values = rows
      .map(
        (r) =>
          `  (${sqlVal(r.station_id)}, ${sqlVal(r.date)}, ${sqlVal(r.increases_count)}, ${sqlVal(
            r.last_increase_time,
          )}, ${sqlVal(r.is_compliant)}, ${sqlVal(r.price_e5)}, ${sqlVal(r.price_e10)}, ${sqlVal(
            r.price_diesel,
          )})`,
      )
      .join(",\n");

    const stmt =
      "INSERT INTO public.daily_compliance\n" +
      "  (station_id, date, increases_count, last_increase_time, is_compliant, price_e5, price_e10, price_diesel) VALUES\n" +
      values +
      "\nON CONFLICT (station_id, date) DO NOTHING;\n\n";
    writeSync(fd, stmt);

    total += rows.length;
    if (rows.length < PAGE) break;
  }
  return total;
}

async function processDate(supabase: SupabaseClient, date: string, dumpDir: string): Promise<void> {
  const nextDay = nextDayUtc(date);
  const dumpPath = join(dumpDir, `dump_${date}_${Date.now()}.sql`);

  let fd: number;
  try {
    fd = openSync(dumpPath, "w");
  } catch (e) {
    log.error(`${date}: failed to open dump file ${dumpPath}: ${(e as Error).message}`);
    log.warn(`${date}: skipping deletion — dump is the safety net`);
    return;
  }

  let priceRowCount = 0;
  let complianceRowCount = 0;
  try {
    writeSync(
      fd,
      `-- Rückspiegel data dump\n-- Date: ${date}\n-- Generated: ${new Date().toISOString()}\n\nBEGIN;\n\n`,
    );

    log.info(`${date}: dumping price_changes…`);
    priceRowCount = await dumpPriceChanges(supabase, date, nextDay, fd);
    log.info(`${date}: dumped ${priceRowCount.toLocaleString()} price_changes row(s)`);

    log.info(`${date}: dumping daily_compliance…`);
    complianceRowCount = await dumpDailyCompliance(supabase, date, fd);
    log.info(`${date}: dumped ${complianceRowCount.toLocaleString()} daily_compliance row(s)`);

    writeSync(fd, "COMMIT;\n");
  } catch (e) {
    log.error(`${date}: dump failed: ${(e as Error).message}`);
    log.warn(`${date}: skipping deletion — dump is the safety net`);
    try {
      closeSync(fd);
    } catch {}
    return;
  }

  try {
    closeSync(fd);
  } catch (e) {
    log.error(`${date}: failed to close dump file: ${(e as Error).message}`);
    log.warn(`${date}: skipping deletion — dump may be incomplete`);
    return;
  }

  log.info(
    `${date}: dump written: ${dumpPath} (${priceRowCount.toLocaleString()} price_changes, ${complianceRowCount.toLocaleString()} daily_compliance rows)`,
  );

  // Delete daily_compliance first (derived data), then price_changes (source).
  let deletedCompliance = 0;
  {
    const { error, count } = await supabase
      .from("daily_compliance")
      .delete({ count: "exact" })
      .eq("date", date);
    if (error) {
      log.error(`${date}: delete daily_compliance failed: ${error.message}`);
      log.warn(`${date}: skipping price_changes deletion`);
      return;
    }
    deletedCompliance = count ?? 0;
    log.info(`${date}: deleted ${deletedCompliance.toLocaleString()} daily_compliance row(s)`);
  }

  let deletedPrices = 0;
  {
    const { error, count } = await supabase
      .from("price_changes")
      .delete({ count: "exact" })
      .gte("created_at", date)
      .lt("created_at", nextDay);
    if (error) {
      log.error(`${date}: delete price_changes failed: ${error.message}`);
      log.warn(`${date}: daily_compliance was already deleted — rerun ingestion to restore`);
      return;
    }
    deletedPrices = count ?? 0;
    log.info(`${date}: deleted ${deletedPrices.toLocaleString()} price_changes row(s)`);
  }

  log.info(
    `${date}: deleted ${deletedPrices.toLocaleString()} price_changes + ${deletedCompliance.toLocaleString()} daily_compliance rows`,
  );
}

async function main() {
  const { dates, dumpDir } = parseArgs();

  mkdirSync(dumpDir, { recursive: true });

  const supabase = requireSupabase();
  log.info(`deleting ${dates.length} date(s): ${dates.join(", ")}`);
  log.info(`dump directory: ${dumpDir}`);

  for (const date of dates) {
    await processDate(supabase, date, dumpDir);
  }

  log.info(`done in ${((Date.now() - log.startedAt()) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
