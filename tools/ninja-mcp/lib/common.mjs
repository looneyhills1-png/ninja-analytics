// Shared helpers for the Ninja Analytics MCP server: argument validation,
// date ranges, site lookup, pagination and the freshness/provenance envelope.
// Pure functions where possible so they can be tested without a database.

export const DEFAULT_DAYS = 28;
export const MAX_DAYS = 180;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export class ToolError extends Error {}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export const addDays = (iso, n) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);

export const daysBetween = (a, b) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS,
  );

/** Validate arguments against a small JSON-Schema subset; reject extras. */
export function validateArgs(schema, args) {
  const input = args ?? {};
  if (typeof input !== "object" || Array.isArray(input))
    throw new ToolError("Arguments must be an object.");
  const props = schema.properties ?? {};
  for (const key of Object.keys(input)) {
    if (!(key in props)) throw new ToolError(`Unknown argument: ${key}`);
  }
  for (const key of schema.required ?? []) {
    if (input[key] === undefined)
      throw new ToolError(`Missing argument: ${key}`);
  }
  const out = {};
  for (const [key, def] of Object.entries(props)) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    if (def.type === "string") {
      if (typeof v !== "string")
        throw new ToolError(`${key} must be a string.`);
      if (v.length > (def.maxLength ?? 300))
        throw new ToolError(`${key} is too long.`);
      if (def.enum && !def.enum.includes(v))
        throw new ToolError(`${key} must be one of: ${def.enum.join(", ")}.`);
      if (def.format === "date" && !isIsoDate(v))
        throw new ToolError(`${key} must be a real date, YYYY-MM-DD.`);
    } else if (def.type === "integer") {
      if (!Number.isInteger(v))
        throw new ToolError(`${key} must be an integer.`);
      if (def.minimum !== undefined && v < def.minimum)
        throw new ToolError(`${key} must be at least ${def.minimum}.`);
      if (def.maximum !== undefined && v > def.maximum)
        throw new ToolError(`${key} must be at most ${def.maximum}.`);
    } else if (def.type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v))
        throw new ToolError(`${key} must be a number.`);
    } else if (def.type === "boolean") {
      if (typeof v !== "boolean")
        throw new ToolError(`${key} must be true or false.`);
    }
    out[key] = v;
  }
  return out;
}

/**
 * Work out the reporting window. Default: the last 28 days ending at the
 * latest day that actually has data (not "today", because Search Console and
 * GA4 trail by a couple of days). Never more than 180 days.
 */
export function resolveRange(args, dataThrough, now = new Date()) {
  const fallbackEnd = addDays(now.toISOString().slice(0, 10), -1);
  const days = args.days ?? DEFAULT_DAYS;
  if (days < 1 || days > MAX_DAYS)
    throw new ToolError(`days must be between 1 and ${MAX_DAYS}.`);
  let start = args.start_date;
  let end = args.end_date;
  if (start && end) {
    if (start > end) throw new ToolError("start_date is after end_date.");
  } else if (end) {
    start = addDays(end, -(days - 1));
  } else if (start) {
    end = addDays(start, days - 1);
  } else {
    end = dataThrough ?? fallbackEnd;
    start = addDays(end, -(days - 1));
  }
  const length = daysBetween(start, end) + 1;
  if (length > MAX_DAYS)
    throw new ToolError(
      `The range is ${length} days; the maximum is ${MAX_DAYS}.`,
    );
  return {
    start,
    end,
    days: length,
    prevStart: addDays(start, -length),
    prevEnd: addDays(start, -1),
  };
}

export function pageArgs(args) {
  return {
    limit: Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT),
    offset: args.offset ?? 0,
  };
}

export function pagination({ limit, offset }, total, returned) {
  const next = offset + returned;
  return {
    limit,
    offset,
    returned,
    total,
    next_offset: next < total ? next : null,
  };
}

export const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const hoursSince = (iso, now) =>
  iso ? (now.getTime() - new Date(iso).getTime()) / 3_600_000 : null;

/**
 * fresh | stale | incomplete | unavailable.
 *  unavailable: the integration has never produced data for this request
 *  stale:       the last successful sync is older than stale_after_hours
 *  incomplete:  the requested window reaches outside the days we hold
 */
export function freshness({ status, bounds, range, now = new Date() }) {
  const warnings = [];
  const hasData = !!bounds && bounds.rows > 0;
  if (!hasData) {
    return {
      state: "unavailable",
      data_from: null,
      data_through: null,
      days_with_data: 0,
      last_successful_sync: status?.last_success_at ?? null,
      warnings: ["No stored data for this site and source."],
    };
  }
  let state = "fresh";
  const staleAfter = status?.stale_after_hours ?? 36;
  const age = hoursSince(status?.last_success_at, now);
  if (!status?.last_success_at || age > staleAfter) {
    state = "stale";
    warnings.push(
      status?.last_success_at
        ? `Last successful sync was ${Math.round(age)}h ago (limit ${staleAfter}h).`
        : "This source has never synced successfully.",
    );
  }
  if (range && (range.end > bounds.max_date || range.start < bounds.min_date)) {
    if (state === "fresh") state = "incomplete";
    warnings.push(
      `Stored data covers ${bounds.min_date} to ${bounds.max_date}; the requested window ${range.start} to ${range.end} reaches outside it.`,
    );
  }
  if (status && status.consecutive_failures > 0) {
    warnings.push(
      `The last ${status.consecutive_failures} sync attempt(s) failed${status.last_error_code ? ` (${status.last_error_code})` : ""}.`,
    );
  }
  return {
    state,
    data_from: bounds.min_date,
    data_through: bounds.max_date,
    days_with_data: bounds.days,
    last_successful_sync: status?.last_success_at ?? null,
    warnings,
  };
}

export const SOURCE_LABELS = {
  gsc: "Google Search Console (exact first-party, stored daily)",
  bing: "Bing Webmaster Tools (exact first-party, stored daily)",
  ga4: "Google Analytics 4 (exact first-party, stored daily totals)",
  ninja_audit: "Ninja Analytics site crawl (own first-party crawl)",
  ninja_coverage: "Ninja Analytics coverage check + Google URL Inspection API",
  ninja_calc: "Calculated by Ninja Analytics from stored data",
};

export function envelope(
  tool,
  { site, source, fresh, range, page, data, notes },
) {
  return {
    tool,
    generated_at: new Date().toISOString(),
    site: site ? { id: site.id, name: site.name, domain: site.domain } : null,
    source: { id: source, description: SOURCE_LABELS[source] ?? source },
    freshness: fresh
      ? { status: fresh.state, ...strip(fresh, ["state", "warnings"]) }
      : undefined,
    range: range
      ? { start_date: range.start, end_date: range.end, days: range.days }
      : undefined,
    warnings: [...(fresh?.warnings ?? []), ...(notes ?? [])],
    pagination: page,
    data,
  };
}

function strip(obj, keys) {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

export function pct(cur, prev) {
  if (prev === null || prev === undefined || Number(prev) === 0) return null;
  return (
    Math.round(((Number(cur ?? 0) - Number(prev)) / Number(prev)) * 1000) / 10
  );
}

/** Resolve a site by id, domain or name (www. and case ignored). */
export async function findSite(db, ref) {
  const { rows } = await db.query(
    "select id, name, domain, website_url, gsc_property, ga4_property_id, bing_site_url, is_active, hosting_platform from public.sites order by name",
  );
  if (!ref)
    throw new ToolError(
      "site is required (id, domain or name). Use list_sites.",
    );
  const norm = (s) =>
    String(s)
      .toLowerCase()
      .replace(/^www\./, "")
      .trim();
  const wanted = norm(ref);
  const hits = rows.filter(
    (s) =>
      s.id === ref ||
      norm(s.domain) === wanted ||
      norm(s.name) === wanted ||
      norm(s.name).replace(/\s+/g, "") === wanted.replace(/\s+/g, ""),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length > 1)
    throw new ToolError(`"${ref}" matches several sites; use the id.`);
  throw new ToolError(
    `Unknown site "${ref}". Known sites: ${rows.map((s) => s.domain).join(", ")}.`,
  );
}

export async function integrationStatus(db, siteId, source) {
  const { rows } = await db.query(
    "select source, enabled, last_attempt_at, last_success_at, last_status, consecutive_failures, last_error_code, stale_after_hours from public.integration_status where site_id=$1 and source=$2",
    [siteId, source],
  );
  return rows[0] ?? null;
}

const BOUNDS_TABLES = new Set([
  "search_daily",
  "search_query_daily",
  "search_page_daily",
  "search_query_page_daily",
  "search_appearance_daily",
  "analytics_daily",
]);

/** Min/max/day-count of stored data for a site (and engine) in one table. */
export async function dataBounds(db, table, siteId, engine) {
  if (!BOUNDS_TABLES.has(table)) throw new Error("bounds table not allowed");
  const params = [siteId];
  let where = "site_id=$1";
  if (engine) {
    params.push(engine);
    where += " and engine=$2";
  }
  const { rows } = await db.query(
    `select min(metric_date)::text min_date, max(metric_date)::text max_date, count(distinct metric_date)::int days, count(*)::int rows from public.${table} where ${where}`,
    params,
  );
  return rows[0];
}

export const SOURCE_FOR_ENGINE = { google: "gsc", bing: "bing" };

export const num = (v) => (v === null || v === undefined ? null : Number(v));
