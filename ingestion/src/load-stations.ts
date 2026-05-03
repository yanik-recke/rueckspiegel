import { parse } from "csv-parse/sync";
import { fetchCsvText, log, requireEnv, requireSupabase, yesterdayBerlin } from "./lib";

const TK_USER = requireEnv("TK_USER");
const TK_PASS = requireEnv("TK_PASS");

type Row = {
  uuid: string;
  name: string;
  brand: string;
  street: string;
  house_number: string;
  post_code: string;
  city: string;
  latitude: string;
  longitude: string;
  first_active: string;
  openingtimes_json: string;
};

function buildStreet(street: string, houseNumber: string): string | null {
  const s = (street || "").trim();
  const n = (houseNumber || "").trim();
  const combined = [s, n].filter(Boolean).join(" ").trim();
  return combined || null;
}

function toEwkt(lng: string, lat: string): string | null {
  const x = Number(lng);
  const y = Number(lat);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (x === 0 && y === 0) return null;
  return `SRID=4326;POINT(${x} ${y})`;
}

async function main() {
  const { y, m, d } = yesterdayBerlin();
  const url = `https://data.tankerkoenig.de/tankerkoenig-organization/tankerkoenig-data/raw/branch/master/stations/${y}/${m}/${y}-${m}-${d}-stations.csv`;
  log.info(`source date: ${y}-${m}-${d} (Europe/Berlin, yesterday)`);
  log.info(`GET ${url.replace(/\/\/[^/]+/, "//data.tankerkoenig.de")}`);

  const csv = await fetchCsvText(url, TK_USER, TK_PASS);

  const rows: Row[] = parse(csv, { columns: true, skip_empty_lines: true, relax_quotes: true });
  log.info(`parsed ${rows.length.toLocaleString()} CSV rows`);

  const skipped = { noUuid: 0, noName: 0, badCoords: 0 };
  const records = rows
    .map((r) => {
      const location = toEwkt(r.longitude, r.latitude);
      if (!r.uuid) {
        skipped.noUuid++;
        return null;
      }
      if (!r.name) {
        skipped.noName++;
        return null;
      }
      if (!location) {
        skipped.badCoords++;
        return null;
      }
      const postcode = (r.post_code || "").trim().slice(0, 5) || null;
      return {
        id: r.uuid,
        name: r.name.trim(),
        brand: (r.brand || "").trim() || null,
        location,
        street: buildStreet(r.street, r.house_number),
        postcode,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const totalSkipped = skipped.noUuid + skipped.noName + skipped.badCoords;
  if (totalSkipped > 0) {
    log.warn(
      `skipped ${totalSkipped} rows (noUuid=${skipped.noUuid}, noName=${skipped.noName}, badCoords=${skipped.badCoords})`,
    );
  }
  log.info(`prepared ${records.length.toLocaleString()} valid records`);

  const supabase = requireSupabase();

  const BATCH = 1000;
  const totalBatches = Math.ceil(records.length / BATCH);
  log.info(`upserting in ${totalBatches} batch(es) of ${BATCH}…`);

  let upserted = 0;
  const upsertStart = Date.now();
  for (let i = 0; i < records.length; i += BATCH) {
    const batchIdx = Math.floor(i / BATCH) + 1;
    const chunk = records.slice(i, i + BATCH);
    const t0 = Date.now();
    const { error } = await supabase.from("stations").upsert(chunk, { onConflict: "id" });
    if (error) throw new Error(`upsert failed (batch ${batchIdx}/${totalBatches}): ${error.message}`);
    upserted += chunk.length;
    const rps = Math.round(chunk.length / Math.max(0.001, (Date.now() - t0) / 1000));
    log.info(
      `batch ${batchIdx}/${totalBatches}: +${chunk.length} (${upserted}/${records.length}, ${rps} rows/s)`,
    );
  }
  const totalSec = ((Date.now() - upsertStart) / 1000).toFixed(1);
  log.info(`upsert complete: ${upserted} rows in ${totalSec}s`);
  log.info(`done in ${((Date.now() - log.startedAt()) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
