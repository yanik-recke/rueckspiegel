import { log, requireSupabase } from "./lib";

const query = process.argv[2] ?? "Behring";

async function main() {
  const supabase = requireSupabase();

  log.info(`searching stations matching "${query}"…`);
  const { data: stations, error: sErr } = await supabase
    .from("stations")
    .select("id, name, brand, street, postcode")
    .or(`name.ilike.%${query}%,street.ilike.%${query}%`)
    .limit(20);
  if (sErr) throw new Error(`station lookup failed: ${sErr.message}`);
  if (!stations || stations.length === 0) {
    log.warn("no station matches");
    return;
  }
  for (const s of stations) {
    console.log(`  ${s.id}  ${s.brand ?? "-"}  ${s.name}  | ${s.street ?? ""}, ${s.postcode ?? ""}`);
  }

  // Find latest available day across the whole table.
  const { data: latest } = await supabase
    .from("price_changes")
    .select("created_at")
    .order("created_at", { ascending: false })
    .limit(1);
  if (!latest || latest.length === 0) {
    log.warn("no price_changes anywhere");
    return;
  }
  const latestISO = (latest[0] as { created_at: string }).created_at;

  // Berlin date of latest event.
  const berlinDateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const offsetFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    timeZoneName: "longOffset",
  });
  const date = berlinDateFmt.format(new Date(latestISO));
  const offsetPart = offsetFmt
    .formatToParts(new Date(latestISO))
    .find((p) => p.type === "timeZoneName")?.value;
  const offset = offsetPart ? offsetPart.replace("GMT", "") || "+01:00" : "+01:00";
  const [yy, mm, dd] = date.split("-").map(Number);
  const nextUTC = new Date(Date.UTC(yy, mm - 1, dd + 1));
  const nextDate = nextUTC.toISOString().slice(0, 10);
  const startISO = `${date}T00:00:00${offset}`;
  const endISO = `${nextDate}T00:00:00${offset}`;
  log.info(`latest day: ${date} (window ${startISO} .. ${endISO})`);

  for (const s of stations) {
    const { data: prices, error: pErr } = await supabase
      .from("price_changes")
      .select("id, price_e5, price_e10, price_diesel, created_at")
      .eq("station_id", s.id)
      .gte("created_at", startISO)
      .lt("created_at", endISO)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true });
    if (pErr) {
      log.error(`prices for ${s.id}: ${pErr.message}`);
      continue;
    }
    const rows = prices ?? [];
    console.log(`\n=== ${s.brand ?? "-"} ${s.name} (${s.id}) — ${rows.length} rows ===`);

    const berlinTimeFmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    let prevE5: number | null = null;
    for (const r of rows as Array<{
      id: number;
      price_e5: number | null;
      price_e10: number | null;
      price_diesel: number | null;
      created_at: string;
    }>) {
      const t = berlinTimeFmt.format(new Date(r.created_at));
      const e5 = r.price_e5 === null ? "    -" : (r.price_e5 / 1000).toFixed(3);
      const e10 = r.price_e10 === null ? "    -" : (r.price_e10 / 1000).toFixed(3);
      const di = r.price_diesel === null ? "    -" : (r.price_diesel / 1000).toFixed(3);
      let marker = "  ";
      if (r.price_e5 !== null && prevE5 !== null) {
        if (r.price_e5 > prevE5) marker = "↑↑";
        else if (r.price_e5 < prevE5) marker = "↓ ";
      } else if (r.price_e5 !== null && prevE5 === null) {
        marker = "· "; // first non-null E5 (no comparison)
      } else if (r.price_e5 === null && prevE5 !== null) {
        marker = "?  "; // null E5 mid-day — suspicious
      }
      console.log(
        `  id=${String(r.id).padStart(7)}  ${t}  E5=${e5}  E10=${e10}  D=${di}  ${marker}`,
      );
      if (r.price_e5 !== null) prevE5 = r.price_e5;
    }
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? e.message : String(e));
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
