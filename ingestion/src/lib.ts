import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[fatal] missing env: ${name}`);
    process.exit(1);
  }
  return v;
}

const startedAt = Date.now();
function ts(): string {
  const s = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(5, " ");
  return `[+${s}s]`;
}
export const log = {
  info: (msg: string) => console.log(`${ts()} ${msg}`),
  warn: (msg: string) => console.warn(`${ts()} WARN ${msg}`),
  error: (msg: string) => console.error(`${ts()} ERROR ${msg}`),
  startedAt: () => startedAt,
};

// Yesterday in Europe/Berlin — today's CSV usually doesn't exist yet.
export function yesterdayBerlin(): { y: string; m: string; d: string } {
  const now = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [y, m, d] = fmt.format(now).split("-");
  return { y, m, d };
}

function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

export async function fetchCsvText(url: string, user: string, pass: string): Promise<string> {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Authorization: basicAuth(user, pass) } });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText}: ${url}`);
  const body = await res.text();
  const kb = (body.length / 1024).toFixed(1);
  log.info(`fetched ${kb} KB in ${Date.now() - t0}ms`);
  return body;
}

export async function fetchCsvStream(
  url: string,
  user: string,
  pass: string,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(url, { headers: { Authorization: basicAuth(user, pass) } });
  if (!res.ok) throw new Error(`fetch failed ${res.status} ${res.statusText}: ${url}`);
  if (!res.body) throw new Error(`fetch returned no body: ${url}`);
  log.info(`streaming response (${res.headers.get("content-length") ?? "unknown"} bytes)`);
  return res.body;
}

export function requireSupabase(): SupabaseClient {
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}
