// Hourly catalogue-freshness pipeline (v2, 2026-09-16).
//
// Two entry points in one function, routed by HTTP method:
//   POST  - the hourly Supabase Cron call. Runs every active/due source
//           check, records results, and - only when a genuine change
//           needs a rebuild and its cooldown has elapsed - POSTs to a
//           Cloudflare Pages Deploy Hook. Never touches GitHub Actions.
//   GET   - called by scripts/apply-catalogue-changes.js during a
//           Cloudflare Pages build (shared-secret gated via the
//           X-Catalogue-Secret header). Returns undispatched changes so
//           the build can run the matching real Node import script,
//           then POSTs back to acknowledge them (see the `ack` route
//           below, also gated).
//
// Database access is a DIRECT Postgres connection (SUPABASE_DB_URL,
// auto-provided to every Edge Function) - this NEVER goes through
// PostgREST/the Data API, so the `catalogue` schema is never exposed to
// Supabase's REST surface at all, regardless of the project's "Exposed
// schemas" setting. This is deliberate (see the migration's own header).
//
// This function does NOT reimplement the existing Node import/build/
// deploy pipeline in Deno - that would mean re-verifying every UK-guard,
// dedup and identity check build.js/ticketmaster-import.js already do,
// with real risk of the two copies drifting apart. It only decides WHEN
// a rebuild is worth triggering; the actual import still runs as real
// Node code, just inside a Cloudflare-triggered build instead of a
// GitHub Actions job.
//
// Every invocation is meant to finish in well under a second when
// nothing changed. Never loops, never sleeps, never waits on anything
// long-running.

import postgres from "npm:postgres@3";

const SUPABASE_DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const TICKETMASTER_API_KEY = Deno.env.get("TICKETMASTER_API_KEY") ?? "";
const AWIN_DATAFEED_API_KEY = Deno.env.get("AWIN_DATAFEED_API_KEY") ?? "";
const CF_DEPLOY_HOOK_URL = Deno.env.get("CF_DEPLOY_HOOK_URL") ?? "";
const CATALOGUE_PENDING_SECRET = Deno.env.get("CATALOGUE_PENDING_SECRET") ?? "";

// Hard safety limits (requirement 11).
const DAILY_HARD_LIMIT = 60;
const MONTHLY_HARD_LIMIT = 1500;

// Capped exponential backoff after consecutive failures (requirement 12).
const BACKOFF_BASE_MINUTES = 5;
const BACKOFF_CAP_MINUTES = 360; // 6h

// Postgres.js connects using the standard connection string; `prepare:
// false` because pgbouncer transaction-mode (what SUPABASE_DB_URL points
// at) doesn't support prepared statements.
const sql = postgres(SUPABASE_DB_URL, { prepare: false });

function nowIso() {
  return new Date().toISOString();
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchJson(url: string, timeoutMs = 15000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

// Ticketmaster's Discovery API enforces a spike-arrest limit tighter than
// "N requests total" (observed: bursts above ~1 in-flight request trip a
// 429, even well under the per-day quota). Every Ticketmaster caller in
// this file goes through here so the various checks - which may run in
// the same invocation - never fire back-to-back with no gap.
let lastTicketmasterCallAt = 0;
const TICKETMASTER_MIN_GAP_MS = 350;

async function fetchTicketmasterJson(url: string): Promise<any> {
  const wait = lastTicketmasterCallAt + TICKETMASTER_MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastTicketmasterCallAt = Date.now();
  return fetchJson(url);
}

// ---------------------------------------------------------------------
// Usage counters (requirement 11)
// ---------------------------------------------------------------------
async function checkAndBumpUsageCounters(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  const today = new Date();
  const dayKey = today.toISOString().slice(0, 10);
  const monthKey = today.toISOString().slice(0, 7);

  const rows = await sql`
    select * from catalogue.usage_counters where period_key in (${dayKey}, ${monthKey})
  `;
  const day = rows.find((r: any) => r.period_key === dayKey);
  const month = rows.find((r: any) => r.period_key === monthKey);

  if (day && day.invocation_count >= day.hard_limit) {
    return {
      ok: false,
      reason: `daily hard limit reached (${day.invocation_count}/${day.hard_limit})`,
    };
  }
  if (month && month.invocation_count >= month.hard_limit) {
    return {
      ok: false,
      reason: `monthly hard limit reached (${month.invocation_count}/${month.hard_limit})`,
    };
  }

  await sql`
    insert into catalogue.usage_counters (period_key, period_type, invocation_count, hard_limit, updated_at)
    values
      (${dayKey}, 'day', ${(day?.invocation_count ?? 0) + 1}, ${day?.hard_limit ?? DAILY_HARD_LIMIT}, now()),
      (${monthKey}, 'month', ${(month?.invocation_count ?? 0) + 1}, ${month?.hard_limit ?? MONTHLY_HARD_LIMIT}, now())
    on conflict (period_key) do update set invocation_count = excluded.invocation_count, updated_at = now()
  `;
  return { ok: true };
}

// ---------------------------------------------------------------------
// Normalised record shape every source check produces.
// ---------------------------------------------------------------------
interface NormalisedRecord {
  providerEventId: string;
  canonicalUrl: string | null;
  name: string;
  venue: string | null;
  city: string | null;
  eventDate: string | null; // YYYY-MM-DD
  status: string;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  seller: string | null;
  raw: Record<string, unknown>;
}

async function fingerprintOf(r: NormalisedRecord): Promise<string> {
  const stable = JSON.stringify([
    r.canonicalUrl,
    r.name,
    r.venue,
    r.city,
    r.eventDate,
    r.status,
    r.priceMin,
    r.priceMax,
    r.currency,
    r.seller,
  ]);
  return sha256Hex(stable);
}

// ---------------------------------------------------------------------
// Source check 1: Oasis, Ticketmaster Discovery, exact attraction
// identity. Ported from scripts/oasis-watch.js + scripts/lib/oasis.js.
// KEEP IN SYNC - scripts/catalogue-check-sync-check.js (npm test) fails
// loudly if these two ever drift.
// ---------------------------------------------------------------------
const OASIS_CONTAMINATION_PATTERNS: RegExp[] = [
  /tribute/i,
  /candlelight/i,
  /oasish/i,
  /definitely\s*mightbe/i,
  /definitely\s*oasis/i,
  /oasis\s*forever/i,
  /oasis\s*96/i,
  /documentary/i,
  /karaoke/i,
  /cover\s*(band|night|show)/i,
  /experience\b.*oasis|oasis\b.*experience/i,
  /oasis\s*(nightclub|leisure\s*centre|centre|club|spa|hotel|bar)/i,
];

const OASIS_LEGACY_ARTIST_ID = "766720";
const OASIS_PINNED_DISCOVERY_ATTRACTION_ID: string | null = null; // set once resolved, mirrors priority-artists.json

function isGenuineOasisTitle(title: string): boolean {
  return !OASIS_CONTAMINATION_PATTERNS.some((re) => re.test(title));
}

async function resolveOasisDiscoveryAttractionId(): Promise<
  { id: string; source: string } | { error: string }
> {
  if (OASIS_PINNED_DISCOVERY_ATTRACTION_ID) {
    return {
      id: OASIS_PINNED_DISCOVERY_ATTRACTION_ID,
      source: "pinned-config",
    };
  }
  const url = `https://app.ticketmaster.com/discovery/v2/attractions.json?keyword=Oasis&classificationName=Music&size=50&apikey=${TICKETMASTER_API_KEY}`;
  const data = await fetchTicketmasterJson(url);
  const attractions = data?._embedded?.attractions ?? [];
  const exact = attractions.filter((a: any) => {
    const nameMatches =
      String(a?.name ?? "")
        .trim()
        .toLowerCase() === "oasis";
    const classifications = Array.isArray(a?.classifications)
      ? a.classifications
      : [];
    const isMusic =
      classifications.length === 0 ||
      classifications.some((c: any) =>
        /^music$/i.test(String(c?.segment?.name ?? "")),
      );
    return nameMatches && isMusic;
  });
  if (exact.length !== 1) {
    return {
      error: `expected exactly 1 exact Music attraction named Oasis, found ${exact.length}`,
    };
  }
  return {
    id: String(exact[0].id),
    source: "exact-attraction-name-resolution",
  };
}

async function checkOasisTicketmaster(): Promise<NormalisedRecord[]> {
  if (!TICKETMASTER_API_KEY)
    throw new Error("TICKETMASTER_API_KEY not configured");

  const identity = await resolveOasisDiscoveryAttractionId();
  if ("error" in identity)
    throw new Error(`identity resolution failed: ${identity.error}`);

  const url = `https://app.ticketmaster.com/discovery/v2/events.json?countryCode=GB&attractionId=${encodeURIComponent(identity.id)}&size=100&sort=date,asc&apikey=${TICKETMASTER_API_KEY}`;
  const data = await fetchTicketmasterJson(url);
  const events = data?._embedded?.events ?? [];

  const out: NormalisedRecord[] = [];
  for (const e of events) {
    const attractionIds: string[] = (e?._embedded?.attractions ?? [])
      .map((a: any) => a?.id)
      .filter(Boolean)
      .map(String);
    if (!attractionIds.includes(identity.id)) continue;
    if (!isGenuineOasisTitle(String(e?.name ?? ""))) continue;

    const venue = e?._embedded?.venues?.[0];
    const priceRanges = Array.isArray(e?.priceRanges) ? e.priceRanges : [];
    const gbp =
      priceRanges.find((p: any) => p?.currency === "GBP") ?? priceRanges[0];

    out.push({
      providerEventId: String(e.id),
      canonicalUrl: e?.url ?? null,
      name: e?.name ?? "Oasis",
      venue: venue?.name ?? null,
      city: venue?.city?.name ?? null,
      eventDate: e?.dates?.start?.localDate ?? null,
      status: e?.dates?.status?.code ?? "unknown",
      priceMin: gbp?.min ?? null,
      priceMax: gbp?.max ?? null,
      currency: gbp?.currency ?? null,
      seller: "Ticketmaster",
      raw: {
        discoveryAttractionId: identity.id,
        resolutionSource: identity.source,
        legacyArtistId: OASIS_LEGACY_ARTIST_ID,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Source check 2: Glastonbury 2027, See Tickets Awin product feed.
// Ported from scripts/glastonbury-watch.js. KEEP IN SYNC (npm test).
// 7816 is See Tickets UK's ADVERTISER id, not a feed id - the real English/
// GB feed under that advertiser is 35853, confirmed via Awin's own
// datafeed/list endpoint (2026-09-16).
// ---------------------------------------------------------------------
const SEE_TICKETS_AWIN_FEED_ID = 35853;

function isGenuineGlastonburyProduct(name: string): boolean {
  const n = String(name || "").toLowerCase();
  return n.includes("glastonbury") && n.includes("2027");
}

// Minimal RFC4180 CSV parser - same approach as scripts/glastonbury-watch.js.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      /* skip */
    } else field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

async function downloadAwinFeedCsv(
  feedId: number,
): Promise<{ rows: string[][]; rawText: string }> {
  const columns = [
    "product_name",
    "merchant_product_id",
    "aw_deep_link",
    "search_price",
    "currency",
  ].join("%2C");
  const url = `https://productdata.awin.com/datafeed/download/apikey/${AWIN_DATAFEED_API_KEY}/fid/${feedId}/format/csv/language/en/delimiter/%2C/compression/gzip/adultcontent/1/columns/${columns}/`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  let bytes: Uint8Array;
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }

  const ds = new DecompressionStream("gzip");
  const decompressed = new Response(new Response(bytes).body!.pipeThrough(ds));
  const csv = await decompressed.text();
  return {
    rows: parseCsv(csv).filter((r) => r.length > 1 && r.some((c) => c.length)),
    rawText: csv,
  };
}

async function checkGlastonburyAwinFeed(): Promise<NormalisedRecord[]> {
  if (!AWIN_DATAFEED_API_KEY)
    throw new Error("AWIN_DATAFEED_API_KEY not configured");

  const { rows } = await downloadAwinFeedCsv(SEE_TICKETS_AWIN_FEED_ID);
  const header = rows[0];
  const nameIdx = header.indexOf("product_name");
  const idIdx = header.indexOf("merchant_product_id");
  const linkIdx = header.indexOf("aw_deep_link");
  const priceIdx = header.indexOf("search_price");
  const currencyIdx = header.indexOf("currency");

  const out: NormalisedRecord[] = [];
  for (const r of rows.slice(1)) {
    const name = r[nameIdx];
    if (!isGenuineGlastonburyProduct(name)) continue;
    const price = parseFloat(r[priceIdx]);
    out.push({
      providerEventId: r[idIdx] || name,
      canonicalUrl: r[linkIdx] || null,
      name,
      venue: "Worthy Farm",
      city: "Pilton",
      eventDate: null, // official dates live in src/data/glastonbury-2027.json, never overwritten from here
      status: "on_sale",
      priceMin: Number.isFinite(price) ? price : null,
      priceMax: Number.isFinite(price) ? price : null,
      currency: r[currencyIdx] || null,
      seller: "See Tickets",
      raw: {
        feedId: SEE_TICKETS_AWIN_FEED_ID,
        productsScanned: rows.length - 1,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Source check 3: Ticketmaster UK - total event count across all 4
// Discovery segments (Music/Sports/Arts&Theatre/Miscellaneous), the
// same segmentation scripts/ticketmaster-import.js uses for nationwide
// coverage. A broad, cheap (4 tiny requests, page size 1) freshness
// signal covering the WHOLE Ticketmaster-sourced catalogue, not just one
// artist - genuinely new UK inventory of any kind changes this number.
// Treated as one "record" (a single synthetic id) so it plugs into the
// same reconcile/fingerprint machinery as the other checks.
// ---------------------------------------------------------------------
const TICKETMASTER_SEGMENTS = [
  "Music",
  "Sports",
  "Arts & Theatre",
  "Miscellaneous",
];

async function checkTicketmasterUkCount(): Promise<NormalisedRecord[]> {
  if (!TICKETMASTER_API_KEY)
    throw new Error("TICKETMASTER_API_KEY not configured");

  let total = 0;
  for (const segment of TICKETMASTER_SEGMENTS) {
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?countryCode=GB&classificationName=${encodeURIComponent(segment)}&size=1&apikey=${TICKETMASTER_API_KEY}`;
    const data = await fetchTicketmasterJson(url);
    total += Number(data?.page?.totalElements ?? 0);
  }

  return [
    {
      providerEventId: "uk-total",
      canonicalUrl: null,
      name: "Ticketmaster UK total event count",
      venue: null,
      city: null,
      eventDate: null,
      status: "unknown",
      priceMin: total, // reusing the numeric field to store the count so the existing fingerprint/diff machinery just works
      priceMax: total,
      currency: null,
      seller: null,
      raw: { totalElements: total, segments: TICKETMASTER_SEGMENTS },
    },
  ];
}

// ---------------------------------------------------------------------
// Source check 4: generic Awin feed content-hash. Not product-name-
// specific like Glastonbury's check - this is a broad "has this
// advertiser's whole feed changed at all" signal, reusable for any Awin
// advertiser by adding a source row with kind='awin_feed_hash' and its
// feed id here. Seeded with LoveToVisit (86769) as the concrete example
// beyond Oasis/Glastonbury.
// ---------------------------------------------------------------------
const AWIN_FEED_HASH_SOURCES: Record<string, number> = {
  lovetovisit_awin_feed: 97905, // LoveToVisit, advertiser 86769 - see scripts/lovetovisit-attach.js
};

async function checkAwinFeedHash(
  sourceKey: string,
): Promise<NormalisedRecord[]> {
  if (!AWIN_DATAFEED_API_KEY)
    throw new Error("AWIN_DATAFEED_API_KEY not configured");
  const feedId = AWIN_FEED_HASH_SOURCES[sourceKey];
  if (!feedId) throw new Error(`no feed id configured for ${sourceKey}`);

  const { rows, rawText } = await downloadAwinFeedCsv(feedId);
  const hash = await sha256Hex(rawText);

  return [
    {
      providerEventId: `feed-${feedId}`,
      canonicalUrl: null,
      name: `Awin feed ${feedId} content hash`,
      venue: null,
      city: null,
      eventDate: null,
      status: "unknown",
      priceMin: null,
      priceMax: null,
      currency: null,
      seller: hash, // reusing the seller text field to carry the hash through the existing fingerprint/diff machinery
      raw: { feedId, productCount: rows.length - 1 },
    },
  ];
}

// ---------------------------------------------------------------------
// Compare a source's freshly normalised records against the last known
// snapshot in catalogue.events, upsert, and log any material changes.
// ---------------------------------------------------------------------
async function reconcileSource(
  sourceKey: string,
  records: NormalisedRecord[],
): Promise<{ changes: number }> {
  const existingRows =
    await sql`select * from catalogue.events where source_key = ${sourceKey}`;
  const existingByProviderId = new Map(
    existingRows.map((r: any) => [r.provider_event_id, r]),
  );

  let changeCount = 0;
  const now = nowIso();

  for (const rec of records) {
    const fingerprint = await fingerprintOf(rec);
    const existing: any = existingByProviderId.get(rec.providerEventId);

    if (!existing) {
      const [inserted] = await sql`
        insert into catalogue.events (
          source_key, provider_event_id, canonical_url, name, venue, city, event_date,
          status, price_min, price_max, currency, seller, fingerprint, raw, first_seen_at, last_seen_at
        ) values (
          ${sourceKey}, ${rec.providerEventId}, ${rec.canonicalUrl}, ${rec.name}, ${rec.venue}, ${rec.city}, ${rec.eventDate},
          ${rec.status}, ${rec.priceMin}, ${rec.priceMax}, ${rec.currency}, ${rec.seller}, ${fingerprint}, ${sql.json(rec.raw)}, ${now}, ${now}
        ) returning id
      `;
      await sql`
        insert into catalogue.changes (source_key, event_row_id, change_type, detail)
        values (${sourceKey}, ${inserted.id}, 'new_event', ${sql.json({ after: rec })})
      `;
      changeCount++;
      continue;
    }

    if (existing.fingerprint === fingerprint) {
      await sql`update catalogue.events set last_seen_at = ${now} where id = ${existing.id}`;
      continue;
    }

    let changeType = "date_or_venue_changed";
    if (rec.status === "cancelled" && existing.status !== "cancelled")
      changeType = "cancelled";
    else if (rec.status === "postponed" && existing.status !== "postponed")
      changeType = "postponed";
    else if (rec.status === "offsale" && existing.status !== "offsale")
      changeType = "expired";
    else if (
      /sold.?out/i.test(rec.status) &&
      !/sold.?out/i.test(existing.status ?? "")
    )
      changeType = "sold_out";
    else if (rec.status === "onsale" && existing.status !== "onsale")
      changeType = "now_on_sale";
    else if (
      rec.priceMin !== existing.price_min ||
      rec.priceMax !== existing.price_max
    )
      changeType = "price_changed";
    else if (rec.seller && rec.seller !== existing.seller)
      changeType = "seller_added";
    else if (
      rec.eventDate !== existing.event_date ||
      rec.venue !== existing.venue
    )
      changeType = "date_or_venue_changed";

    await sql`
      update catalogue.events set
        canonical_url = ${rec.canonicalUrl}, name = ${rec.name}, venue = ${rec.venue}, city = ${rec.city},
        event_date = ${rec.eventDate}, status = ${rec.status}, price_min = ${rec.priceMin}, price_max = ${rec.priceMax},
        currency = ${rec.currency}, seller = ${rec.seller}, fingerprint = ${fingerprint}, raw = ${sql.json(rec.raw)}, last_seen_at = ${now}
      where id = ${existing.id}
    `;
    await sql`
      insert into catalogue.changes (source_key, event_row_id, change_type, detail)
      values (${sourceKey}, ${existing.id}, ${changeType}, ${sql.json({ before: existing, after: rec })})
    `;
    changeCount++;
  }

  return { changes: changeCount };
}

// ---------------------------------------------------------------------
// Trigger the Cloudflare Pages build - the ONLY rebuild mechanism this
// pipeline ever uses. Never GitHub Actions.
// ---------------------------------------------------------------------
async function triggerCloudflareRebuild(): Promise<boolean> {
  if (!CF_DEPLOY_HOOK_URL) {
    console.log("rebuild skipped: CF_DEPLOY_HOOK_URL not configured");
    return false;
  }
  const res = await fetch(CF_DEPLOY_HOOK_URL, { method: "POST" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Cloudflare deploy hook failed: HTTP ${res.status}: ${body.slice(0, 300)}`,
    );
  }
  return true;
}

// ---------------------------------------------------------------------
// Per-source backoff + cooldown gating, then the actual check.
// ---------------------------------------------------------------------
async function runSource(
  source: any,
): Promise<{ ok: boolean; changes: number; rebuildNeeded: boolean }> {
  const checkers: Record<string, () => Promise<NormalisedRecord[]>> = {
    oasis_ticketmaster: checkOasisTicketmaster,
    glastonbury_awin_feed: checkGlastonburyAwinFeed,
    ticketmaster_uk_count: checkTicketmasterUkCount,
    lovetovisit_awin_feed: () => checkAwinFeedHash("lovetovisit_awin_feed"),
  };
  const checker = checkers[source.key];
  if (!checker) {
    console.log(`no checker implemented for source ${source.key} - skipping`);
    return { ok: true, changes: 0, rebuildNeeded: false };
  }

  try {
    const records = await checker();
    const { changes } = await reconcileSource(source.key, records);

    await sql`
      update catalogue.sources set
        last_checked_at = now(), last_success_at = now(), last_error = null,
        consecutive_failures = 0, next_allowed_check_at = now()
      where key = ${source.key}
    `;

    let rebuildNeeded = false;
    if (changes > 0 && source.pending_apply_action !== "none") {
      const cooldownMs = (source.dispatch_cooldown_minutes ?? 20) * 60_000;
      const lastDispatch = source.last_dispatched_at
        ? new Date(source.last_dispatched_at).getTime()
        : 0;
      const withinCooldown = Date.now() - lastDispatch < cooldownMs;

      if (withinCooldown) {
        console.log(
          `${source.key}: ${changes} change(s) found but within cooldown - not rebuilding yet`,
        );
      } else {
        rebuildNeeded = true;
        await sql`update catalogue.sources set last_dispatched_at = now() where key = ${source.key}`;
      }
    }

    return { ok: true, changes, rebuildNeeded };
  } catch (e) {
    const failures = (source.consecutive_failures ?? 0) + 1;
    const backoffMinutes = Math.min(
      BACKOFF_BASE_MINUTES * 2 ** (failures - 1),
      BACKOFF_CAP_MINUTES,
    );
    const nextAllowed = new Date(
      Date.now() + backoffMinutes * 60_000,
    ).toISOString();

    await sql`
      update catalogue.sources set
        last_checked_at = now(), last_error = ${String((e as Error).message ?? e).slice(0, 500)},
        consecutive_failures = ${failures}, next_allowed_check_at = ${nextAllowed}
      where key = ${source.key}
    `;
    console.error(
      `${source.key} check failed (attempt ${failures}, next retry in ${backoffMinutes}m): ${(e as Error).message}`,
    );
    return { ok: false, changes: 0, rebuildNeeded: false };
  }
}

// ---------------------------------------------------------------------
// POST /catalogue-check - the hourly cron entry point.
// ---------------------------------------------------------------------
async function handleHourlyCheck(): Promise<Response> {
  const [runRow] = await sql`
    insert into catalogue.run_log (started_at, status) values (now(), 'running') returning id
  `;
  const runId = runRow.id;

  try {
    const usage = await checkAndBumpUsageCounters();
    if (!usage.ok) {
      await sql`update catalogue.run_log set finished_at = now(), status = 'skipped_limit_reached', error = ${usage.reason} where id = ${runId}`;
      return Response.json({
        status: "skipped_limit_reached",
        reason: usage.reason,
      });
    }

    const sources = await sql`
      select * from catalogue.sources where active = true and next_allowed_check_at <= now()
    `;

    let checked = 0,
      failed = 0,
      totalChanges = 0,
      anyRebuildNeeded = false;

    for (const source of sources) {
      checked++;
      const result = await runSource(source);
      if (!result.ok) failed++;
      totalChanges += result.changes;
      if (result.rebuildNeeded) anyRebuildNeeded = true;
    }

    let deployTriggered = false;
    if (anyRebuildNeeded) {
      deployTriggered = await triggerCloudflareRebuild();
    }

    const status =
      failed === 0 ? "ok" : failed === checked ? "error" : "partial_failure";
    await sql`
      update catalogue.run_log set
        finished_at = now(), status = ${status}, sources_checked = ${checked}, sources_failed = ${failed},
        changes_found = ${totalChanges}, cloudflare_deploy_triggered = ${deployTriggered}
      where id = ${runId}
    `;

    return Response.json({
      status,
      runId,
      sourcesChecked: checked,
      sourcesFailed: failed,
      changesFound: totalChanges,
      cloudflareDeployTriggered: deployTriggered,
    });
  } catch (e) {
    await sql`update catalogue.run_log set finished_at = now(), status = 'error', error = ${String((e as Error).message ?? e).slice(0, 1000)} where id = ${runId}`;
    return Response.json(
      { status: "error", error: (e as Error).message },
      { status: 500 },
    );
  }
}

// ---------------------------------------------------------------------
// GET /catalogue-check - called by scripts/apply-catalogue-changes.js
// during a Cloudflare Pages build. Shared-secret gated (never PostgREST,
// never anon-readable) - returns undispatched changes grouped by the
// action the build script should take.
// ---------------------------------------------------------------------
async function handlePendingChanges(): Promise<Response> {
  const rows = await sql`
    select c.id, c.source_key, c.change_type, c.detail, s.pending_apply_action
    from catalogue.changes c
    join catalogue.sources s on s.key = c.source_key
    where c.dispatched = false
    order by c.detected_at asc
  `;
  const actions = [
    ...new Set(rows.map((r: any) => r.pending_apply_action)),
  ].filter((a) => a !== "none");
  return Response.json({
    pendingChangeIds: rows.map((r: any) => r.id),
    actions,
    count: rows.length,
  });
}

// ---------------------------------------------------------------------
// POST /catalogue-check?ack=1 - acknowledges pending changes were
// applied by a specific Cloudflare deployment (body: {ids, deployment}).
// ---------------------------------------------------------------------
async function handleAck(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const ids: number[] = Array.isArray(body.ids) ? body.ids : [];
  const deployment: string = String(body.deployment ?? "unknown");
  if (!ids.length) return Response.json({ acked: 0 });

  await sql`
    update catalogue.changes set dispatched = true, dispatched_at = now(), applied_by_deployment = ${deployment}
    where id = any(${ids})
  `;
  return Response.json({ acked: ids.length });
}

// Supabase's platform "Verify JWT" gateway check stays ON (the secure
// default - never disabled here). Both callers (Supabase Cron via
// pg_net, and scripts/apply-catalogue-changes.js during a Cloudflare
// build) satisfy it by sending the project's PUBLISHABLE key as the
// Authorization/apikey headers, exactly like the dashboard's own
// "Invoke function" example - that key is meant to be public, so this
// adds no real access. This shared secret is an ADDITIONAL app-level
// gate on top of that, so a bare publishable key alone (which anyone
// could copy from client-side JS) still can't trigger a check or read
// pending changes.
function isAuthorised(req: Request): boolean {
  return (
    !!CATALOGUE_PENDING_SECRET &&
    req.headers.get("X-Catalogue-Secret") === CATALOGUE_PENDING_SECRET
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (!isAuthorised(req)) {
    return new Response("unauthorized", { status: 401 });
  }

  if (req.method === "GET") {
    return handlePendingChanges();
  }

  if (req.method === "POST" && url.searchParams.get("ack") === "1") {
    return handleAck(req);
  }

  if (req.method === "POST") {
    return handleHourlyCheck();
  }

  return new Response("method not allowed", { status: 405 });
});
