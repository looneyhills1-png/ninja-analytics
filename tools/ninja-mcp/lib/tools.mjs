// The Ninja Analytics MCP tool set. Every tool is a fixed, parameterised,
// read-only query against data Ninja Analytics already stores. There is no
// arbitrary SQL, no write path and no outbound call to Google or Bing.
import {
  ToolError,
  MAX_DAYS,
  MAX_LIMIT,
  DEFAULT_DAYS,
  dataBounds,
  envelope,
  escapeLike,
  findSite,
  freshness,
  integrationStatus,
  num,
  pageArgs,
  pagination,
  pct,
  resolveRange,
  SOURCE_FOR_ENGINE,
  validateArgs,
} from "./common.mjs";

const site = {
  type: "string",
  description: "Site id, domain (ww3supply.com) or name. Use list_sites first.",
};
const dateProps = {
  start_date: { type: "string", format: "date", description: "YYYY-MM-DD" },
  end_date: { type: "string", format: "date", description: "YYYY-MM-DD" },
  days: {
    type: "integer",
    minimum: 1,
    maximum: MAX_DAYS,
    description: `Window length when start/end are not both given. Default ${DEFAULT_DAYS}, maximum ${MAX_DAYS}. The window ends at the latest day with stored data.`,
  },
};
const pageProps = {
  limit: {
    type: "integer",
    minimum: 1,
    maximum: MAX_LIMIT,
    description: "Rows per page, default 25, maximum 100.",
  },
  offset: {
    type: "integer",
    minimum: 0,
    description: "Rows to skip; use pagination.next_offset.",
  },
};
const engine = {
  type: "string",
  enum: ["google", "bing"],
  description: "Search engine. Default google.",
};

const POSITION_NOTE =
  "Average position is the impression-weighted mean of Search Console's own daily averages. It is not a live SERP rank.";

// ---------------------------------------------------------------- aggregation

const AGG_TABLES = {
  query: { table: "search_query_daily", key: "query" },
  page: { table: "search_page_daily", key: "page" },
};
const SORTS = {
  clicks: "clicks",
  impressions: "impressions",
  ctr: "ctr",
  position: "average_position",
  clicks_change: "clicks_change",
  impressions_change: "impressions_change",
};

/** Query or page performance for one window, optionally against the one before. */
async function aggregate(db, kind, siteId, eng, range, a) {
  const { table, key } = AGG_TABLES[kind];
  const compare = !!a.compare || !!a.trend;
  const params = [siteId, eng, range.start, range.end];
  const metrics = `${key} as k, sum(clicks)::bigint clicks, sum(impressions)::bigint impressions,
    round(sum(clicks)::numeric / nullif(sum(impressions), 0), 4) ctr,
    round(sum(average_position * impressions) / nullif(sum(impressions), 0), 2) average_position`;
  let sql = `with c as (select ${metrics} from public.${table}
    where site_id=$1 and engine=$2 and metric_date between $3 and $4 group by 1)`;
  if (compare) {
    params.push(range.prevStart, range.prevEnd);
    sql += `, p as (select ${metrics} from public.${table}
      where site_id=$1 and engine=$2 and metric_date between $5 and $6 group by 1)`;
  }
  const conds = [];
  const add = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (compare) {
    sql += ` select coalesce(c.k, p.k) as ${key}, c.clicks, c.impressions, c.ctr, c.average_position,
      p.clicks prev_clicks, p.impressions prev_impressions, p.ctr prev_ctr, p.average_position prev_average_position,
      coalesce(c.clicks,0) - coalesce(p.clicks,0) clicks_change,
      coalesce(c.impressions,0) - coalesce(p.impressions,0) impressions_change,
      count(*) over() total from c full join p on p.k = c.k`;
    if (a.trend === "declining")
      conds.push("coalesce(c.clicks,0) < coalesce(p.clicks,0)");
    if (a.trend === "rising")
      conds.push("coalesce(c.clicks,0) > coalesce(p.clicks,0)");
    if (a.trend === "new") conds.push("p.k is null");
    if (a.trend === "lost") conds.push("c.k is null");
  } else {
    sql += ` select c.k as ${key}, c.clicks, c.impressions, c.ctr, c.average_position,
      count(*) over() total from c`;
  }
  if (a.trend !== "lost") {
    conds.push(`coalesce(c.impressions,0) >= ${add(a.min_impressions ?? 1)}`);
  }
  if (a.contains)
    conds.push(
      `coalesce(c.k${compare ? ", p.k" : ""}) ilike ${add(`%${escapeLike(a.contains)}%`)}`,
    );
  if (a.max_ctr !== undefined) conds.push(`c.ctr <= ${add(a.max_ctr)}`);
  if (a.min_position !== undefined)
    conds.push(`c.average_position >= ${add(a.min_position)}`);
  if (a.max_position !== undefined)
    conds.push(`c.average_position <= ${add(a.max_position)}`);
  if (a.min_clicks !== undefined)
    conds.push(`coalesce(c.clicks,0) >= ${add(a.min_clicks)}`);
  if (a.max_clicks !== undefined)
    conds.push(`coalesce(c.clicks,0) <= ${add(a.max_clicks)}`);
  if (conds.length) sql += ` where ${conds.join(" and ")}`;
  const sortKey = SORTS[a.sort ?? "clicks"];
  if (
    (sortKey === "clicks_change" || sortKey === "impressions_change") &&
    !compare
  )
    throw new ToolError("Sorting by change needs compare=true.");
  const dir = a.order === "asc" ? "asc" : "desc";
  const { limit, offset } = pageArgs(a);
  sql += ` order by ${sortKey} ${dir} nulls last, ${key} limit ${add(limit)} offset ${add(offset)}`;
  const { rows } = await db.query(sql, params);
  const total = rows.length ? Number(rows[0].total) : 0;
  return {
    rows: rows.map(({ total: _t, ...r }) => normaliseRow(r)),
    total,
    page: pagination({ limit, offset }, total, rows.length),
  };
}

function normaliseRow(r) {
  const o = {};
  for (const [k, v] of Object.entries(r))
    o[k] =
      typeof v === "string" &&
      /^-?\d+(\.\d+)?$/.test(v) &&
      k !== "query" &&
      k !== "page"
        ? Number(v)
        : v;
  return o;
}

/** Site-level totals for the same window, to show how much the rows account for. */
async function siteSearchTotals(db, siteId, eng, range) {
  const { rows } = await db.query(
    `select coalesce(sum(clicks),0)::bigint clicks, coalesce(sum(impressions),0)::bigint impressions,
       round(sum(clicks)::numeric / nullif(sum(impressions),0), 4) ctr,
       round(sum(average_position * impressions) / nullif(sum(impressions),0), 2) average_position
     from public.search_daily where site_id=$1 and engine=$2 and metric_date between $3 and $4`,
    [siteId, eng, range.start, range.end],
  );
  const r = rows[0];
  return {
    clicks: num(r.clicks),
    impressions: num(r.impressions),
    ctr: num(r.ctr),
    average_position: num(r.average_position),
  };
}

/** Shared preamble: resolve site, engine, bounds, range and freshness. */
async function searchContext(db, a, table, now) {
  const s = await findSite(db, a.site);
  const eng = a.engine ?? "google";
  const status = await integrationStatus(db, s.id, SOURCE_FOR_ENGINE[eng]);
  const bounds = await dataBounds(db, table, s.id, eng);
  const range = resolveRange(a, bounds?.max_date ?? null, now);
  const fresh = freshness({ status, bounds, range, now });
  return { s, eng, range, fresh };
}

const aggProps = {
  site,
  engine,
  ...dateProps,
  ...pageProps,
  compare: {
    type: "boolean",
    description: "Add the equal-length previous period and the change.",
  },
  trend: {
    type: "string",
    enum: ["declining", "rising", "new", "lost"],
    description:
      "Filter to rows that fell, rose, are new this period or disappeared (implies compare).",
  },
  contains: {
    type: "string",
    description: "Case-insensitive text the row must contain.",
  },
  min_impressions: { type: "integer", minimum: 0 },
  min_clicks: { type: "integer", minimum: 0 },
  max_clicks: { type: "integer", minimum: 0 },
  max_ctr: {
    type: "number",
    description:
      "Keep rows with CTR at or below this fraction, e.g. 0.01 = 1%.",
  },
  min_position: { type: "number" },
  max_position: { type: "number" },
  sort: {
    type: "string",
    enum: Object.keys(SORTS),
    description: "Default clicks.",
  },
  order: {
    type: "string",
    enum: ["asc", "desc"],
    description: "Default desc.",
  },
};

// --------------------------------------------------------------------- tools

export const TOOLS = [
  {
    name: "list_sites",
    description:
      "List the websites in Ninja Analytics with per-source integration status (Google Search Console, GA4, Bing), last successful sync and whether each is fresh or stale. Start here.",
    properties: {},
    async run(ctx) {
      const { db, now } = ctx;
      const { rows: sites } = await db.query(
        "select id, name, domain, website_url, is_active, hosting_platform from public.sites order by name",
      );
      const { rows: status } = await db.query(
        "select site_id, source, enabled, last_success_at, last_status, consecutive_failures, last_error_code, stale_after_hours from public.integration_status",
      );
      const data = sites.map((s) => ({
        ...s,
        integrations: status
          .filter((i) => i.site_id === s.id)
          .map((i) => {
            const age = i.last_success_at
              ? (now - new Date(i.last_success_at)) / 3_600_000
              : null;
            return {
              source: i.source,
              enabled: i.enabled,
              last_successful_sync: i.last_success_at,
              last_status: i.last_status,
              consecutive_failures: i.consecutive_failures,
              last_error_code: i.last_error_code,
              state: !i.last_success_at
                ? "unavailable"
                : age > (i.stale_after_hours ?? 36)
                  ? "stale"
                  : "fresh",
            };
          }),
      }));
      return envelope("list_sites", { source: "ninja_calc", data });
    },
  },

  {
    name: "site_overview",
    description:
      "Headline performance for one site and window: Google or Bing clicks, impressions, CTR and average position, plus GA4 sessions, users, engagement and key events, each against the previous period. Optional daily series.",
    properties: {
      site,
      engine,
      ...dateProps,
      include_daily: {
        type: "boolean",
        description: "Add the daily series (max 180 rows).",
      },
    },
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const { s, eng, range, fresh } = await searchContext(
        db,
        a,
        "search_daily",
        now,
      );
      const sums = async (from, to) =>
        (
          await db.query(
            `select coalesce(sum(clicks),0)::bigint clicks, coalesce(sum(impressions),0)::bigint impressions,
              round(sum(clicks)::numeric / nullif(sum(impressions),0), 4) ctr,
              round(sum(average_position * impressions) / nullif(sum(impressions),0), 2) average_position,
              count(*)::int days
             from public.search_daily where site_id=$1 and engine=$2 and metric_date between $3 and $4`,
            [s.id, eng, from, to],
          )
        ).rows[0];
      const cur = await sums(range.start, range.end);
      const prev = await sums(range.prevStart, range.prevEnd);
      const gaFrom = async (from, to) =>
        (
          await db.query(
            `select coalesce(sum(sessions),0)::bigint sessions, coalesce(sum(total_users),0)::bigint users_daily_sum,
              coalesce(sum(active_users),0)::bigint active_users_daily_sum, coalesce(sum(screen_page_views),0)::bigint page_views,
              coalesce(sum(engaged_sessions),0)::bigint engaged_sessions, coalesce(sum(event_count),0)::bigint events,
              coalesce(sum(key_events),0)::bigint key_events, count(*)::int days
             from public.analytics_daily where site_id=$1 and metric_date between $2 and $3`,
            [s.id, from, to],
          )
        ).rows[0];
      const gaCur = await gaFrom(range.start, range.end);
      const gaPrev = await gaFrom(range.prevStart, range.prevEnd);
      const gaBounds = await dataBounds(db, "analytics_daily", s.id);
      const gaFresh = freshness({
        status: await integrationStatus(db, s.id, "ga4"),
        bounds: gaBounds,
        range,
        now,
      });
      const rate = (g) =>
        Number(g.sessions) > 0
          ? Math.round(
              (Number(g.engaged_sessions) / Number(g.sessions)) * 1000,
            ) / 1000
          : null;
      const search = (r, p) => ({
        clicks: num(r.clicks),
        impressions: num(r.impressions),
        ctr: num(r.ctr),
        average_position: num(r.average_position),
        days_with_data: r.days,
        ...(p
          ? {
              clicks_change_pct: pct(r.clicks, p.clicks),
              impressions_change_pct: pct(r.impressions, p.impressions),
            }
          : {}),
      });
      const data = {
        search_engine: eng,
        search: {
          current: search(cur, prev),
          previous: search(prev),
          previous_range: {
            start_date: range.prevStart,
            end_date: range.prevEnd,
          },
        },
        ga4: {
          freshness: {
            status: gaFresh.state,
            data_through: gaFresh.data_through,
            last_successful_sync: gaFresh.last_successful_sync,
            warnings: gaFresh.warnings,
          },
          current: { ...gaStats(gaCur), engagement_rate: rate(gaCur) },
          previous: { ...gaStats(gaPrev), engagement_rate: rate(gaPrev) },
          sessions_change_pct: pct(gaCur.sessions, gaPrev.sessions),
          note: "GA4 data held locally is daily site totals only: no landing page, channel, device or country breakdown.",
        },
      };
      if (a.include_daily) {
        const { rows } = await db.query(
          `select to_char(d.metric_date,'YYYY-MM-DD') date, d.clicks, d.impressions, d.ctr, d.average_position,
             g.sessions, g.engaged_sessions, g.key_events
           from public.search_daily d left join public.analytics_daily g on g.site_id=d.site_id and g.metric_date=d.metric_date
           where d.site_id=$1 and d.engine=$2 and d.metric_date between $3 and $4 order by d.metric_date`,
          [s.id, eng, range.start, range.end],
        );
        data.daily = rows.map(normaliseRow);
      }
      const notes = [POSITION_NOTE];
      if (!prev.days)
        notes.push(
          `No ${eng} data is stored for the previous period (${range.prevStart} to ${range.prevEnd}), so search changes are null.`,
        );
      if (!gaPrev.days)
        notes.push(
          "No GA4 data is stored for the previous period, so GA4 changes are null.",
        );
      return envelope("site_overview", {
        site: s,
        source: SOURCE_FOR_ENGINE[eng],
        fresh,
        range,
        data,
        notes,
      });
    },
  },

  {
    name: "search_queries",
    description:
      "Google or Bing search queries for a site: clicks, impressions, CTR, average position. Filter by text, impressions, CTR, position; sort; page through results; compare with the previous period or show only declining/rising/new/lost queries. Example: impressions but few clicks = min_impressions with max_ctr.",
    properties: aggProps,
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const { s, eng, range, fresh } = await searchContext(
        db,
        a,
        "search_query_daily",
        now,
      );
      const r = await aggregate(db, "query", s.id, eng, range, a);
      const totals = await siteSearchTotals(db, s.id, eng, range);
      return envelope("search_queries", {
        site: s,
        source: SOURCE_FOR_ENGINE[eng],
        fresh,
        range,
        page: r.page,
        data: { site_totals_same_window: totals, rows: r.rows },
        notes: [
          POSITION_NOTE,
          "Search engines withhold rare (anonymised) queries, so query rows never add up to the site totals.",
        ],
      });
    },
  },

  {
    name: "search_pages",
    description:
      "Page-level search performance (clicks, impressions, CTR, position per URL) for Google or Bing, with the same filters, sorting, comparison and trend options as search_queries. Use trend=declining to find pages losing traffic.",
    properties: aggProps,
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const { s, eng, range, fresh } = await searchContext(
        db,
        a,
        "search_page_daily",
        now,
      );
      const r = await aggregate(db, "page", s.id, eng, range, a);
      return envelope("search_pages", {
        site: s,
        source: SOURCE_FOR_ENGINE[eng],
        fresh,
        range,
        page: r.page,
        data: {
          site_totals_same_window: await siteSearchTotals(db, s.id, eng, range),
          rows: r.rows,
        },
        notes: [POSITION_NOTE],
      });
    },
  },

  {
    name: "query_page_map",
    description:
      "Which pages rank for which queries. Give a query to see every page that ranks for it, or a page to see its queries. cannibalisation_only keeps queries where two or more pages compete.",
    properties: {
      site,
      engine,
      ...dateProps,
      ...pageProps,
      query: { type: "string", description: "Exact query text." },
      page: { type: "string", description: "Exact page URL." },
      min_impressions: { type: "integer", minimum: 0 },
      cannibalisation_only: { type: "boolean" },
    },
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const { s, eng, range, fresh } = await searchContext(
        db,
        a,
        "search_query_page_daily",
        now,
      );
      const { limit, offset } = pageArgs(a);
      const params = [s.id, eng, range.start, range.end];
      const add = (v) => (params.push(v), `$${params.length}`);
      const conds = ["metric_date between $3 and $4"];
      if (a.query) conds.push(`query = ${add(a.query)}`);
      if (a.page) conds.push(`page = ${add(a.page)}`);
      const minImp = add(a.min_impressions ?? 1);
      const sql = `with agg as (select query, page, sum(clicks)::bigint clicks, sum(impressions)::bigint impressions,
          round(sum(clicks)::numeric/nullif(sum(impressions),0),4) ctr,
          round(sum(average_position*impressions)/nullif(sum(impressions),0),2) average_position
        from public.search_query_page_daily where site_id=$1 and engine=$2 and ${conds.join(" and ")}
        group by query, page having sum(impressions) >= ${minImp}),
        m as (select *, count(*) over (partition by query) pages_for_query from agg)
        select query, page, clicks, impressions, ctr, average_position, pages_for_query, count(*) over() total
        from m ${a.cannibalisation_only ? "where pages_for_query >= 2" : ""}
        order by impressions desc, query, page limit ${add(limit)} offset ${add(offset)}`;
      const { rows } = await db.query(sql, params);
      const total = rows.length ? Number(rows[0].total) : 0;
      return envelope("query_page_map", {
        site: s,
        source: SOURCE_FOR_ENGINE[eng],
        fresh,
        range,
        page: pagination({ limit, offset }, total, rows.length),
        data: { rows: rows.map(({ total: _t, ...r }) => normaliseRow(r)) },
        notes: [
          POSITION_NOTE,
          "pages_for_query > 1 means more than one URL earned impressions for that query (possible cannibalisation).",
        ],
      });
    },
  },

  {
    name: "search_breakdown",
    description:
      "Search performance by device, country or search type (web/image/video/news) from Ninja Analytics' stored Search Console snapshots. These are periodic 28-day snapshots, not daily rows.",
    properties: {
      site,
      ...pageProps,
      dimension: { type: "string", enum: ["device", "country", "search_type"] },
    },
    required: ["site", "dimension"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const s = await findSite(db, a.site);
      const { limit, offset } = pageArgs(a);
      const latest = (
        await db.query(
          "select max(captured_at) c from public.search_dimension_snapshots where site_id=$1 and dimension=$2",
          [s.id, a.dimension],
        )
      ).rows[0].c;
      const status = await integrationStatus(db, s.id, "gsc");
      if (!latest) {
        return envelope("search_breakdown", {
          site: s,
          source: "gsc",
          fresh: freshness({ status, bounds: null }),
          page: pagination({ limit, offset }, 0, 0),
          data: { rows: [] },
          notes: ["No snapshot has been captured for this dimension yet."],
        });
      }
      const { rows } = await db.query(
        `select key, clicks, impressions, ctr, position, to_char(window_start,'YYYY-MM-DD') window_start,
           to_char(window_end,'YYYY-MM-DD') window_end, count(*) over() total
         from public.search_dimension_snapshots where site_id=$1 and dimension=$2 and captured_at=$3
         order by clicks desc, impressions desc, key limit $4 offset $5`,
        [s.id, a.dimension, latest, limit, offset],
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      const ageDays = (now - new Date(latest)) / 86_400_000;
      const fresh = {
        state: ageDays > 10 ? "stale" : "fresh",
        data_from: rows[0]?.window_start ?? null,
        data_through: rows[0]?.window_end ?? null,
        days_with_data: 28,
        last_successful_sync: latest,
        warnings:
          ageDays > 10
            ? [`Snapshot is ${Math.round(ageDays)} days old (captured weekly).`]
            : [],
      };
      return envelope("search_breakdown", {
        site: s,
        source: "gsc",
        fresh,
        page: pagination({ limit, offset }, total, rows.length),
        data: {
          captured_at: latest,
          rows: rows.map(({ total: _t, ...r }) => normaliseRow(r)),
        },
        notes: [
          "A snapshot of one fixed window; it cannot be re-cut to another date range.",
        ],
      });
    },
  },

  {
    name: "ga4_report",
    description:
      "GA4 data Ninja Analytics stores: daily sessions, users, page views, engaged sessions, events and key events (conversions) for a site and window, with totals against the previous period. GA4 landing pages, channels, devices and countries are NOT stored locally; this tool says so rather than guessing.",
    properties: { site, ...dateProps },
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const s = await findSite(db, a.site);
      const bounds = await dataBounds(db, "analytics_daily", s.id);
      const range = resolveRange(a, bounds?.max_date ?? null, now);
      const fresh = freshness({
        status: await integrationStatus(db, s.id, "ga4"),
        bounds,
        range,
        now,
      });
      const { rows } = await db.query(
        `select to_char(metric_date,'YYYY-MM-DD') date, sessions, total_users, active_users, screen_page_views,
           engaged_sessions, event_count, key_events from public.analytics_daily
         where site_id=$1 and metric_date between $2 and $3 order by metric_date`,
        [s.id, range.start, range.end],
      );
      const tot = (list) =>
        list.reduce((t, r) => {
          for (const k of [
            "sessions",
            "screen_page_views",
            "engaged_sessions",
            "event_count",
            "key_events",
          ])
            t[k] = (t[k] ?? 0) + Number(r[k] ?? 0);
          return t;
        }, {});
      const prev = (
        await db.query(
          `select sessions, screen_page_views, engaged_sessions, event_count, key_events from public.analytics_daily
           where site_id=$1 and metric_date between $2 and $3`,
          [s.id, range.prevStart, range.prevEnd],
        )
      ).rows;
      const cur = tot(rows),
        pre = tot(prev);
      return envelope("ga4_report", {
        site: s,
        source: "ga4",
        fresh,
        range,
        data: {
          totals: cur,
          previous_totals: pre,
          change_pct: Object.fromEntries(
            Object.keys(cur).map((k) => [k, pct(cur[k], pre[k])]),
          ),
          daily: rows.map(normaliseRow),
          not_stored: [
            "landing pages",
            "default channel group / traffic sources",
            "device category",
            "country",
            "individual conversion events by name",
            "outbound or affiliate link clicks",
          ],
        },
        notes: [
          "Daily users cannot be summed into unique users for a period; user counts are shown per day only.",
        ],
      });
    },
  },

  {
    name: "index_coverage",
    description:
      "Index coverage for a site: pages discovered, looked up in Google, indexed, excluded (with Google's reasons) and technical errors, from Ninja Analytics' latest coverage snapshot and URL Inspection results. Totals are UNKNOWN until every discovered page has been inspected. Optional URL list by state.",
    properties: {
      site,
      ...pageProps,
      state: {
        type: "string",
        enum: ["indexed", "not_indexed", "unknown_to_google", "any"],
        description: "Also list inspected URLs in this state (default none).",
      },
    },
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const s = await findSite(db, a.site);
      const snaps = (
        await db.query(
          "select captured_at, discovered, live_checked, inspected, indexed, excluded, unknown_state, technical_errors, complete, detail from public.coverage_snapshots where site_id=$1 order by captured_at desc limit 2",
          [s.id],
        )
      ).rows;
      const [latest, previous] = snaps;
      if (!latest) {
        return envelope("index_coverage", {
          site: s,
          source: "ninja_coverage",
          fresh: freshness({ status: null, bounds: null }),
          data: { coverage: null },
          notes: ["Coverage has not been checked yet."],
        });
      }
      const age = (now - new Date(latest.captured_at)) / 3_600_000;
      const fresh = {
        state: age > 48 ? "stale" : latest.complete ? "fresh" : "incomplete",
        data_from: null,
        data_through: latest.captured_at,
        days_with_data: null,
        last_successful_sync: latest.captured_at,
        warnings: [
          ...(age > 48
            ? [`Coverage was last captured ${Math.round(age)}h ago.`]
            : []),
          ...(latest.complete
            ? []
            : [
                `Only ${latest.inspected} of ${latest.discovered} discovered pages have been looked up in Google, so site-wide indexed/excluded totals are UNKNOWN.`,
              ]),
        ],
      };
      const { limit, offset } = pageArgs(a);
      let list = null,
        page;
      if (a.state) {
        const cond = {
          indexed: "verdict = 'PASS'",
          not_indexed:
            "verdict <> 'PASS' and coverage_state not ilike '%unknown to Google%'",
          unknown_to_google: "coverage_state ilike '%unknown to Google%'",
          any: "true",
        }[a.state];
        const { rows } = await db.query(
          `select url, verdict, coverage_state, indexing_state, last_crawl_time, last_inspected_at, count(*) over() total
           from public.url_inspections where site_id=$1 and ${cond} order by last_inspected_at desc, url limit $2 offset $3`,
          [s.id, limit, offset],
        );
        const total = rows.length ? Number(rows[0].total) : 0;
        list = rows.map(({ total: _t, ...r }) => r);
        page = pagination({ limit, offset }, total, rows.length);
      }
      const sitemaps = (
        await db.query(
          "select path, last_submitted, last_downloaded, is_pending, warnings, errors, checked_at from public.gsc_sitemaps where site_id=$1 order by path",
          [s.id],
        )
      ).rows;
      return envelope("index_coverage", {
        site: s,
        source: "ninja_coverage",
        fresh,
        page,
        data: {
          captured_at: latest.captured_at,
          pages_discovered: latest.discovered,
          pages_checked_live: latest.live_checked,
          pages_looked_up_in_google: latest.inspected,
          indexed_so_far: latest.indexed,
          indexed_total: latest.complete ? latest.indexed : "UNKNOWN",
          excluded_so_far: latest.excluded,
          unknown_to_google_so_far: latest.unknown_state,
          technical_errors: latest.technical_errors,
          complete: latest.complete,
          excluded_by_reason: latest.detail?.excludedByReason ?? [],
          previous: previous
            ? {
                captured_at: previous.captured_at,
                discovered: previous.discovered,
                inspected: previous.inspected,
                indexed: previous.indexed,
              }
            : null,
          sitemaps_in_google: sitemaps,
          urls: list,
        },
        notes: [
          "Google's 'Page indexing' and Core Web Vitals reports have no API, so they are not available here. Counts come from the URL Inspection API.",
        ],
      });
    },
  },

  {
    name: "url_inspection",
    description:
      "Google URL Inspection results Ninja Analytics has stored, with when each was inspected, plus Ninja's own live check of the page (status, canonical, noindex, title, schema). Give a url for one page, or filter by verdict. Lookups are never run on demand here.",
    properties: {
      site,
      ...pageProps,
      url: { type: "string", maxLength: 2000 },
      verdict: { type: "string", enum: ["PASS", "NEUTRAL", "FAIL", "PARTIAL"] },
    },
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const s = await findSite(db, a.site);
      const { limit, offset } = pageArgs(a);
      const params = [s.id];
      const conds = ["i.site_id=$1"];
      if (a.url) (params.push(a.url), conds.push(`i.url = $${params.length}`));
      if (a.verdict)
        (params.push(a.verdict), conds.push(`i.verdict = $${params.length}`));
      params.push(limit, offset);
      const { rows } = await db.query(
        `select i.url, i.verdict, i.coverage_state, i.indexing_state, i.page_fetch_state, i.robots_txt_state,
           i.google_canonical, i.user_canonical, i.last_crawl_time, i.last_inspected_at, i.ninja_status,
           i.inspection_result_link, v.live_status, v.live_canonical, v.live_noindex, v.live_title, v.live_has_schema,
           v.live_word_count, v.in_sitemap, v.live_checked_at, count(*) over() total
         from public.url_inspections i left join public.url_inventory v on v.site_id=i.site_id and v.url=i.url
         where ${conds.join(" and ")} order by i.last_inspected_at desc, i.url limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      const newest = (
        await db.query(
          "select max(last_inspected_at) m from public.url_inspections where site_id=$1",
          [s.id],
        )
      ).rows[0].m;
      const age = newest ? (now - new Date(newest)) / 86_400_000 : null;
      const fresh = {
        state: !newest ? "unavailable" : age > 10 ? "stale" : "fresh",
        data_from: null,
        data_through: newest,
        days_with_data: null,
        last_successful_sync: newest,
        warnings: !newest
          ? ["No URL has been inspected yet."]
          : age > 10
            ? [`Newest inspection is ${Math.round(age)} days old.`]
            : [],
      };
      return envelope("url_inspection", {
        site: s,
        source: "ninja_coverage",
        fresh,
        page: pagination({ limit, offset }, total, rows.length),
        data: { rows: rows.map(({ total: _t, ...r }) => r) },
        notes: [
          "Google's view (verdict, coverage_state) and Ninja's live request (live_*) are separate facts; our request is not Googlebot.",
        ],
      });
    },
  },

  {
    name: "technical_seo",
    description:
      "Latest Ninja Analytics site-crawl results: health score, error/warning/notice counts, issue summary by type and the individual issues (exact URL, severity, message). Filter by severity or category.",
    properties: {
      site,
      ...pageProps,
      severity: { type: "string", enum: ["error", "warning", "notice"] },
      category: { type: "string", maxLength: 80 },
    },
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const s = await findSite(db, a.site);
      const run = (
        await db.query(
          `select id, started_at, finished_at, status, pages_crawled, health_score, errors_count, warnings_count, notices_count
           from public.site_audit_runs where site_id=$1 and status='success' order by finished_at desc limit 1`,
          [s.id],
        )
      ).rows[0];
      if (!run) {
        return envelope("technical_seo", {
          site: s,
          source: "ninja_audit",
          fresh: freshness({ status: null, bounds: null }),
          data: { run: null },
          notes: ["No completed site crawl exists for this site."],
        });
      }
      const { limit, offset } = pageArgs(a);
      const params = [run.id];
      const conds = ["run_id=$1"];
      if (a.severity)
        (params.push(a.severity), conds.push(`severity=$${params.length}`));
      if (a.category)
        (params.push(a.category), conds.push(`category=$${params.length}`));
      const summary = (
        await db.query(
          `select severity, category, code, count(*)::int count, min(message) example_message
           from public.site_audit_issues where ${conds.join(" and ")} group by 1,2,3 order by count desc limit 60`,
          params,
        )
      ).rows;
      params.push(limit, offset);
      const { rows } = await db.query(
        `select url, severity, category, code, message, count(*) over() total from public.site_audit_issues
         where ${conds.join(" and ")} order by case severity when 'error' then 0 when 'warning' then 1 else 2 end, url, code
         limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      const age = (now - new Date(run.finished_at)) / 3_600_000;
      const fresh = {
        state: age > 24 * 8 ? "stale" : "fresh",
        data_from: run.started_at,
        data_through: run.finished_at,
        days_with_data: null,
        last_successful_sync: run.finished_at,
        warnings:
          age > 24 * 8
            ? [`The newest crawl is ${Math.round(age / 24)} days old.`]
            : [],
      };
      return envelope("technical_seo", {
        site: s,
        source: "ninja_audit",
        fresh,
        page: pagination({ limit, offset }, total, rows.length),
        data: {
          run: {
            finished_at: run.finished_at,
            pages_crawled: run.pages_crawled,
            health_score: run.health_score,
            errors: run.errors_count,
            warnings: run.warnings_count,
            notices: run.notices_count,
          },
          issue_summary: summary,
          issues: rows.map(({ total: _t, ...r }) => r),
        },
        notes: [
          "The crawl is Ninja Analytics' own bounded crawl, not Google's view.",
        ],
      });
    },
  },

  {
    name: "content_intelligence",
    description:
      "Where to improve content, from stored Search Console/Bing data. section = declining_pages (lost clicks vs previous period), low_ctr_queries (many impressions, few clicks), near_page_one (average position 8-20 with demand), lost_queries (had impressions last period, none now) or opportunities (Ninja's open recommendation queue with evidence).",
    properties: {
      site,
      engine,
      ...dateProps,
      ...pageProps,
      section: {
        type: "string",
        enum: [
          "declining_pages",
          "low_ctr_queries",
          "near_page_one",
          "lost_queries",
          "opportunities",
        ],
      },
    },
    required: ["site", "section"],
    async run(ctx, a) {
      const { db, now } = ctx;
      if (a.section === "opportunities") {
        const s = await findSite(db, a.site);
        const { limit, offset } = pageArgs(a);
        const { rows } = await db.query(
          `select kind, title, target_url, problem, proposal, priority, effort, status, requires_publish_approval,
             first_seen_at, last_seen_at, evidence_at, impact_is_estimate, expected_impact, count(*) over() total
           from public.opportunities where site_id=$1 and status not in ('dismissed','done','closed')
           order by priority desc nulls last, last_seen_at desc limit $2 offset $3`,
          [s.id, limit, offset],
        );
        const total = rows.length ? Number(rows[0].total) : 0;
        const newest = (
          await db.query(
            "select max(last_seen_at) m from public.opportunities where site_id=$1",
            [s.id],
          )
        ).rows[0].m;
        return envelope("content_intelligence", {
          site: s,
          source: "ninja_calc",
          fresh: {
            state: newest ? "fresh" : "unavailable",
            data_from: null,
            data_through: newest,
            days_with_data: null,
            last_successful_sync: newest,
            warnings: [],
          },
          page: pagination({ limit, offset }, total, rows.length),
          data: {
            section: a.section,
            rows: rows.map(({ total: _t, ...r }) => r),
          },
          notes: [
            "Opportunities are calculated by Ninja Analytics; expected impact is an estimate, never a measured result.",
          ],
        });
      }
      const preset = {
        declining_pages: [
          "page",
          {
            trend: "declining",
            sort: "clicks_change",
            order: "asc",
            min_impressions: 20,
          },
        ],
        low_ctr_queries: [
          "query",
          {
            sort: "impressions",
            min_impressions: 100,
            max_ctr: 0.02,
            max_position: 12,
          },
        ],
        near_page_one: [
          "query",
          {
            sort: "impressions",
            min_impressions: 50,
            min_position: 8,
            max_position: 20,
          },
        ],
        lost_queries: [
          "query",
          { trend: "lost", sort: "impressions_change", order: "asc" },
        ],
      }[a.section];
      const table =
        preset[0] === "page" ? "search_page_daily" : "search_query_daily";
      const { s, eng, range, fresh } = await searchContext(db, a, table, now);
      const merged = { ...preset[1], ...a };
      const r = await aggregate(db, preset[0], s.id, eng, range, merged);
      return envelope("content_intelligence", {
        site: s,
        source: SOURCE_FOR_ENGINE[eng],
        fresh,
        range,
        page: r.page,
        data: {
          section: a.section,
          rule: describePreset(a.section),
          rows: r.rows,
        },
        notes: [
          POSITION_NOTE,
          "Rankings are Search Console averages; whether a change is worth making needs a human check of the page.",
        ],
      });
    },
  },

  {
    name: "ai_visibility",
    description:
      "Measured AI/search-appearance data Ninja Analytics holds: Bing AI Performance citation snapshots and cited pages, Search Console search-appearance rows (including AI features where Google exposes them) and any manual AI visibility observations. Does not invent prompt volume.",
    properties: { site, ...dateProps },
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const s = await findSite(db, a.site);
      const bing = (
        await db.query(
          `select id, captured_at, range_label, total_citations, average_cited_pages, notes from public.bing_ai_performance_snapshots
           where site_id=$1 order by captured_at desc limit 5`,
          [s.id],
        )
      ).rows;
      const cited = bing[0]
        ? (
            await db.query(
              "select page_url, citations from public.bing_ai_cited_pages where snapshot_id=$1 order by citations desc limit 25",
              [bing[0].id],
            )
          ).rows
        : [];
      const bounds = await dataBounds(db, "search_appearance_daily", s.id);
      const range = resolveRange(a, bounds?.max_date ?? null, now);
      const appearance = (
        await db.query(
          `select engine, search_appearance, sum(clicks)::bigint clicks, sum(impressions)::bigint impressions
           from public.search_appearance_daily where site_id=$1 and metric_date between $2 and $3 group by 1,2 order by impressions desc`,
          [s.id, range.start, range.end],
        )
      ).rows;
      const obs = (
        await db.query(
          `select source, count(*)::int observations, count(*) filter (where is_cited)::int cited, max(observed_at) last_observed
           from public.ai_visibility_observations where site_id=$1 group by source order by observations desc`,
          [s.id],
        )
      ).rows;
      const newestBing = bing[0]?.captured_at ?? null;
      const fresh = {
        state:
          !newestBing && !appearance.length && !obs.length
            ? "unavailable"
            : "incomplete",
        data_from: null,
        data_through: newestBing,
        days_with_data: null,
        last_successful_sync: newestBing,
        warnings: [],
      };
      return envelope("ai_visibility", {
        site: s,
        source: "bing",
        fresh,
        range,
        data: {
          bing_ai_performance: bing.map(({ id: _i, ...r }) => normaliseRow(r)),
          bing_cited_pages_latest: cited,
          google_search_appearance: appearance.map(normaliseRow),
          manual_observations_by_source: obs,
        },
        notes: [
          "Bing AI Performance is a snapshot export; Google exposes no per-query AI Overview or AI Mode data through its API.",
          "Manual observations are sampled tests, never platform-wide prompt data.",
        ],
      });
    },
  },

  {
    name: "compare_sites",
    description:
      "Cross-domain comparison of every active site for the same window against the previous equal-length period: search clicks/impressions/CTR/position and GA4 sessions/key events, with percentage changes.",
    properties: { engine, ...dateProps },
    async run(ctx, a) {
      const { db, now } = ctx;
      const eng = a.engine ?? "google";
      const bounds = (
        await db.query(
          "select max(metric_date)::text m from public.search_daily where engine=$1",
          [eng],
        )
      ).rows[0].m;
      const range = resolveRange(a, bounds, now);
      const { rows: sites } = await db.query(
        "select id, name, domain from public.sites where is_active order by name",
      );
      const data = [];
      const warnings = [];
      for (const s of sites) {
        const one = async (from, to) => ({
          search: (
            await db.query(
              `select coalesce(sum(clicks),0)::bigint clicks, coalesce(sum(impressions),0)::bigint impressions,
               round(sum(clicks)::numeric/nullif(sum(impressions),0),4) ctr,
               round(sum(average_position*impressions)/nullif(sum(impressions),0),2) average_position, count(*)::int days
             from public.search_daily where site_id=$1 and engine=$2 and metric_date between $3 and $4`,
              [s.id, eng, from, to],
            )
          ).rows[0],
          ga: (
            await db.query(
              `select coalesce(sum(sessions),0)::bigint sessions, coalesce(sum(engaged_sessions),0)::bigint engaged_sessions,
               coalesce(sum(key_events),0)::bigint key_events, count(*)::int days
             from public.analytics_daily where site_id=$1 and metric_date between $2 and $3`,
              [s.id, from, to],
            )
          ).rows[0],
        });
        const c = await one(range.start, range.end);
        const p = await one(range.prevStart, range.prevEnd);
        if (p.search.days === 0)
          warnings.push(
            `${s.domain}: no previous-period search data, so changes are null.`,
          );
        const st = await integrationStatus(db, s.id, SOURCE_FOR_ENGINE[eng]);
        data.push({
          site: s.domain,
          name: s.name,
          search_sync: st?.last_success_at ?? null,
          search: {
            current: normaliseRow(c.search),
            previous: normaliseRow(p.search),
            clicks_change_pct: pct(c.search.clicks, p.search.clicks),
            impressions_change_pct: pct(
              c.search.impressions,
              p.search.impressions,
            ),
          },
          ga4: {
            current: normaliseRow(c.ga),
            previous: normaliseRow(p.ga),
            sessions_change_pct: pct(c.ga.sessions, p.ga.sessions),
            key_events_change_pct: pct(c.ga.key_events, p.ga.key_events),
          },
        });
      }
      return envelope("compare_sites", {
        site: null,
        source: SOURCE_FOR_ENGINE[eng],
        range,
        data: {
          previous_range: {
            start_date: range.prevStart,
            end_date: range.prevEnd,
          },
          sites: data,
        },
        notes: [...warnings, POSITION_NOTE],
      });
    },
  },

  {
    name: "system_health",
    description:
      "Integration and data health: for every site and source (GSC, GA4, Bing) the last successful sync, consecutive failures, latest error, whether data is stale, plus recent failed sync runs and the newest uptime check.",
    properties: {
      site: { ...site, description: "Optional; omit for all sites." },
    },
    async run(ctx, a) {
      const { db, now } = ctx;
      const s = a.site ? await findSite(db, a.site) : null;
      const filter = s ? "where i.site_id = $1" : "";
      const p = s ? [s.id] : [];
      const { rows: integ } = await db.query(
        `select st.domain, i.source, i.enabled, i.last_status, i.last_success_at, i.last_attempt_at, i.consecutive_failures,
           i.last_error_code, left(i.last_error_message, 200) last_error_message, i.stale_after_hours, i.last_rows_written
         from public.integration_status i join public.sites st on st.id = i.site_id ${filter} order by st.domain, i.source`,
        p,
      );
      const { rows: failures } = await db.query(
        `select st.domain, r.source, r.status, r.started_at, r.error_code, left(r.error_message, 200) error_message
         from public.sync_runs r join public.sites st on st.id = r.site_id
         where r.status <> 'success' and r.started_at > now() - interval '7 days' ${s ? "and r.site_id = $1" : ""}
         order by r.started_at desc limit 20`,
        p,
      );
      const { rows: up } = await db.query(
        `select distinct on (u.site_id) st.domain, u.checked_at, u.ok, u.status_code, u.latency_ms
         from public.uptime_checks u join public.sites st on st.id = u.site_id ${s ? "where u.site_id = $1" : ""}
         order by u.site_id, u.checked_at desc`,
        p,
      );
      const issues = [];
      const rows = integ.map((i) => {
        const age = i.last_success_at
          ? (now - new Date(i.last_success_at)) / 3_600_000
          : null;
        const state = !i.enabled
          ? "disabled"
          : age === null
            ? "unavailable"
            : age > i.stale_after_hours
              ? "stale"
              : "fresh";
        if (state === "stale" || state === "unavailable")
          issues.push(`${i.domain} ${i.source}: ${state}`);
        if (i.consecutive_failures > 0)
          issues.push(
            `${i.domain} ${i.source}: ${i.consecutive_failures} consecutive failures`,
          );
        return {
          ...i,
          state,
          hours_since_success: age === null ? null : Math.round(age * 10) / 10,
        };
      });
      return envelope("system_health", {
        site: s,
        source: "ninja_calc",
        fresh: {
          state: issues.length ? "stale" : "fresh",
          data_from: null,
          data_through: now.toISOString(),
          days_with_data: null,
          last_successful_sync: null,
          warnings: issues,
        },
        data: {
          integrations: rows,
          failed_sync_runs_7d: failures,
          uptime_latest: up,
          problems: issues,
        },
      });
    },
  },

  {
    name: "fix_tracking",
    description:
      "Fix and optimisation tracking: proposed, approved, applied, deployed and verified changes (optimisation items, Run Fix runs) with status, deployment state (e.g. blocked because the host has no publishing interface), commit, and verification evidence. Counts by status plus a paged list.",
    properties: {
      site,
      ...pageProps,
      status: {
        type: "string",
        maxLength: 40,
        description: "Optional status filter, e.g. needs_approval.",
      },
    },
    required: ["site"],
    async run(ctx, a) {
      const { db, now } = ctx;
      const s = await findSite(db, a.site);
      const { limit, offset } = pageArgs(a);
      const counts = (
        await db.query(
          "select status, deployment, count(*)::int count from public.optimisation_changes where site_id=$1 group by 1,2 order by count desc",
          [s.id],
        )
      ).rows;
      const params = [s.id];
      let cond = "site_id=$1";
      if (a.status)
        (params.push(a.status), (cond += ` and status=$${params.length}`));
      params.push(limit, offset);
      const { rows } = await db.query(
        `select title, url, problem, change_class, risk, priority, status, deployment, left(deployment_note, 300) deployment_note,
           auto_eligible, commit_sha, rollback_sha, created_at, updated_at, count(*) over() total
         from public.optimisation_changes where ${cond} order by priority desc nulls last, updated_at desc
         limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      const fixRuns = (
        await db.query(
          `select query, url, state, commit_sha, deployed_at, live_verification, error_message, created_at
         from public.fix_runs where site_id=$1 order by created_at desc limit 10`,
          [s.id],
        )
      ).rows;
      const newest = (
        await db.query(
          "select max(updated_at) m from public.optimisation_changes where site_id=$1",
          [s.id],
        )
      ).rows[0].m;
      return envelope("fix_tracking", {
        site: s,
        source: "ninja_calc",
        fresh: {
          state: newest ? "fresh" : "unavailable",
          data_from: null,
          data_through: newest,
          days_with_data: null,
          last_successful_sync: newest,
          warnings: [],
        },
        page: pagination({ limit, offset }, total, rows.length),
        data: {
          counts_by_status_and_deployment: counts,
          changes: rows.map(({ total: _t, ...r }) => r),
          run_fix_runs_latest: fixRuns,
          verified_definition:
            "A change counts as independently verified only when a Run Fix run records live_verification or the opportunity has measured after_metrics. Proposed or blocked items are not verified.",
        },
      });
    },
  },

  {
    name: "describe_capabilities",
    description:
      "What this server can and cannot answer: tools, limits (180-day maximum, 100 rows per page), data held per site with date ranges, and what Ninja Analytics does not store (so you can say so instead of guessing).",
    properties: {},
    async run(ctx) {
      const { db } = ctx;
      const { rows: sites } = await db.query(
        "select id, domain from public.sites where is_active order by domain",
      );
      const held = [];
      for (const s of sites) {
        const b = async (t, e) => dataBounds(db, t, s.id, e);
        held.push({
          site: s.domain,
          google_search_daily: await b("search_daily", "google"),
          google_queries: await b("search_query_daily", "google"),
          google_pages: await b("search_page_daily", "google"),
          bing_search_daily: await b("search_daily", "bing"),
          ga4_daily: await b("analytics_daily"),
        });
      }
      return envelope("describe_capabilities", {
        source: "ninja_calc",
        data: {
          tools: TOOLS.map((t) => t.name),
          limits: {
            default_window_days: DEFAULT_DAYS,
            max_window_days: MAX_DAYS,
            max_rows_per_page: MAX_LIMIT,
            read_only: true,
            arbitrary_sql: false,
          },
          data_held: held,
          not_available: [
            "GA4 landing pages, channels, devices, countries and named conversion events (only daily site totals are stored)",
            "Affiliate/outbound link click and revenue data (not collected)",
            "Google Search Console 'Page indexing' and Core Web Vitals reports (no Google API)",
            "Search volume and competitor rankings (never invented; no paid data)",
            "Live Google/Bing lookups: every answer comes from data already stored by scheduled syncs",
          ],
        },
      });
    },
  },
];

function describePreset(section) {
  return {
    declining_pages:
      "Pages with fewer clicks than the previous equal period and at least 20 impressions, biggest loss first.",
    low_ctr_queries:
      "Queries with at least 100 impressions, CTR at or below 2% and average position 12 or better.",
    near_page_one:
      "Queries with at least 50 impressions and average position between 8 and 20.",
    lost_queries:
      "Queries that had impressions in the previous period and none in this one.",
  }[section];
}

function gaStats(g) {
  return {
    sessions: num(g.sessions),
    page_views: num(g.page_views),
    engaged_sessions: num(g.engaged_sessions),
    events: num(g.events),
    key_events: num(g.key_events),
    days_with_data: g.days,
  };
}

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/** MCP tool definitions (JSON Schema). Every tool is declared read-only. */
export function toolDefinitions() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: "object",
      properties: t.properties,
      ...(t.required ? { required: t.required } : {}),
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
}

export async function callTool(name, args, ctx) {
  const tool = TOOL_INDEX.get(name);
  if (!tool) throw new ToolError(`Unknown tool: ${name}`);
  const clean = validateArgs(
    { properties: tool.properties, required: tool.required },
    args,
  );
  return tool.run(ctx, clean);
}
