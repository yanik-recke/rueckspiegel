import { parse } from "csv-parse";
import { Readable } from "node:stream";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCsvStream, log, requireEnv, requireSupabase, yesterdayBerlin } from "./lib";

const TK_USER = requireEnv("TK_USER");
const TK_PASS = requireEnv("TK_PASS");

type Row = {
  date: string;
  station_uuid: string;
  diesel: string;
  e5: string;
  e10: string;
  dieselchange: string;
  e5change: string;
  e10change: string;
};

type PriceRecord = {
  station_id: string;
  created_at: string;
  price_e5: number | null;
  price_e10: number | null;
  price_diesel: number | null;
};

// CSV stores euros as decimals (e.g. "1.859"); schema stores integer tenths-of-cent.
function toMilliEuros(value: string, change: string): number | null {
  // change codes: 0=no change, 1=change, 2=removed, 3=new
  if (change === "2") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 1000);
}

async function loadAllStationIds(supabase: SupabaseClient): Promise<Set<string>> {
  const PAGE = 1000;
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("stations")
      .select("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`station id preflight failed: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string }>;
    for (const r of rows) ids.add(r.id);
    if (rows.length < PAGE) break;
  }
  return ids;
}

function parseDateArg(): { y: string; m: string; d: string; label: string } {
  const idx = process.argv.indexOf("--date");
  if (idx === -1) {
    const { y, m, d } = yesterdayBerlin();
    return { y, m, d, label: `${y}-${m}-${d} (Europe/Berlin, yesterday)` };
  }
  const value = process.argv[idx + 1];
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    console.error(`[fatal] --date expects YYYY-MM-DD, got ${value ?? "(missing)"}`);
    process.exit(1);
  }
  const [y, m, d] = value.split("-");
  return { y, m, d, label: `${y}-${m}-${d} (Europe/Berlin, --date)` };
}

async function main() {
  const { y, m, d, label } = parseDateArg();
  const dateStr = `${y}-${m}-${d}`;
  const url = `https://data.tankerkoenig.de/tankerkoenig-organization/tankerkoenig-data/raw/branch/master/prices/${y}/${m}/${dateStr}-prices.csv`;
  log.info(`source date: ${label}`);
  log.info(`GET ${url.replace(/\/\/[^/]+/, "//data.tankerkoenig.de")}`);

  const supabase = requireSupabase();

  log.info("preflight: loading station IDs…");
  const knownStationIds = await loadAllStationIds(supabase);
  log.info(`preflight: ${knownStationIds.size.toLocaleString()} stations known`);
  if (knownStationIds.size === 0) {
    log.error("stations table is empty — run load-stations first");
    process.exit(1);
  }

  const stream = await fetchCsvStream(url, TK_USER, TK_PASS);
  const nodeStream = Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
  const parser = nodeStream.pipe(
    parse({ columns: true, skip_empty_lines: true, relax_quotes: true }),
  );

  const BATCH = 5000;
  let buffer: PriceRecord[] = [];
  let total = 0;
  let inserted = 0;
  const skipped = { noChange: 0, badRow: 0, allNull: 0, unknownStation: 0 };
  let batchIdx = 0;
  const upsertStart = Date.now();

  async function flush() {
    if (buffer.length === 0) return;
    batchIdx++;
    const chunk = buffer;
    buffer = [];
    const t0 = Date.now();
    const { error } = await supabase
      .from("price_changes")
      .upsert(chunk, { onConflict: "station_id,created_at", ignoreDuplicates: true });
    if (error) throw new Error(`upsert failed (batch ${batchIdx}): ${error.message}`);
    inserted += chunk.length;
    const rps = Math.round(chunk.length / Math.max(0.001, (Date.now() - t0) / 1000));
    log.info(`batch ${batchIdx}: +${chunk.length} (total ${inserted}, ${rps} rows/s)`);
  }

  for await (const r of parser as AsyncIterable<Row>) {
    total++;

    if (!r.station_uuid || !r.date) {
      skipped.badRow++;
      continue;
    }
    if (!knownStationIds.has(r.station_uuid)) {
      skipped.unknownStation++;
      continue;
    }
    if (r.e5change === "0" && r.e10change === "0" && r.dieselchange === "0") {
      skipped.noChange++;
      continue;
    }

    const price_e5 = toMilliEuros(r.e5, r.e5change);
    const price_e10 = toMilliEuros(r.e10, r.e10change);
    const price_diesel = toMilliEuros(r.diesel, r.dieselchange);
    if (price_e5 === null && price_e10 === null && price_diesel === null) {
      skipped.allNull++;
      continue;
    }

    buffer.push({
      station_id: r.station_uuid,
      created_at: r.date,
      price_e5,
      price_e10,
      price_diesel,
    });

    if (buffer.length >= BATCH) await flush();
  }
  await flush();

  const totalSec = ((Date.now() - upsertStart) / 1000).toFixed(1);
  const totalSkipped =
    skipped.noChange + skipped.badRow + skipped.allNull + skipped.unknownStation;
  log.info(
    `parsed ${total.toLocaleString()} rows; skipped ${totalSkipped} (noChange=${skipped.noChange}, badRow=${skipped.badRow}, allNull=${skipped.allNull}, unknownStation=${skipped.unknownStation})`,
  );
  if (skipped.unknownStation > 0) {
    log.warn(
      `${skipped.unknownStation} rows referenced stations not in our DB (run load-stations to refresh)`,
    );
  }
  log.info(`upsert complete: ${inserted} attempted in ${totalSec}s across ${batchIdx} batch(es)`);

  log.info(`recomputing daily_compliance for ${dateStr}…`);
  const t0 = Date.now();
  const { data: rolledUp, error: rpcErr } = await supabase.rpc("recompute_daily_compliance", {
    target_date: dateStr,
  });
  if (rpcErr) {
    log.error(`recompute failed: ${rpcErr.message}`);
    process.exit(1);
  }
  log.info(
    `recomputed daily_compliance for ${dateStr}: ${Number(rolledUp ?? 0).toLocaleString()} rows in ${Date.now() - t0}ms`,
  );

  log.info(`done in ${((Date.now() - log.startedAt()) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
