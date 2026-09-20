// manage-portfolio: the single write path for tracked queries. Same trust
// model as manage-sites - a valid session, aal2 (MFA), and admin allowlist
// membership are all verified before any write. The table has a server-side
// row cap so no authenticated session can bloat the database.

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError } from "../_shared/errors.ts";
import {
  MAX_COMPETITOR_DOMAINS_PER_SITE,
  MAX_TRACKED_QUERIES_PER_SITE,
  MAX_TRACKED_RANK_KEYWORDS_PER_SITE,
  parseCompetitorDomainInput,
  parseRankObservationInput,
  parseRemoveCompetitorDomainInput,
  parseRemoveTrackedRankKeywordInput,
  parseSerpObservationInput,
  parseTrackedQueryInput,
  parseTrackedRankKeywordInput,
} from "../_shared/portfolio-input.ts";

function validationError(message: string, cors: Record<string, string>) {
  return json(400, { ok: false, error: "validation_error", message }, cors);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, cors);
    }

    const { admin } = await requireAdminMfa(req);

    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const action = body?.action;

    // Tracked queries --------------------------------------------------------
    if (action === "tracked-query.add") {
      const parsed = parseTrackedQueryInput(body?.trackedQuery);
      if (!parsed.ok) return validationError(parsed.error, cors);
      const input = parsed.value;

      const { count, error: countError } = await admin
        .from("tracked_queries")
        .select("query", { count: "exact", head: true })
        .eq("site_id", input.siteId);
      if (countError) throw countError;
      if ((count ?? 0) >= MAX_TRACKED_QUERIES_PER_SITE) {
        return json(
          409,
          {
            ok: false,
            error: "limit_reached",
            message: `A site may track at most ${MAX_TRACKED_QUERIES_PER_SITE} queries.`,
          },
          cors,
        );
      }

      const { error } = await admin
        .from("tracked_queries")
        .upsert(
          { site_id: input.siteId, query: input.query },
          { onConflict: "site_id,query", ignoreDuplicates: true },
        );
      if (error) throw error;
      return json(200, { ok: true }, cors);
    }

    if (action === "tracked-query.remove") {
      const parsed = parseTrackedQueryInput(body?.trackedQuery);
      if (!parsed.ok) return validationError(parsed.error, cors);
      const { error } = await admin
        .from("tracked_queries")
        .delete()
        .eq("site_id", parsed.value.siteId)
        .eq("query", parsed.value.query);
      if (error) throw error;
      return json(200, { ok: true }, cors);
    }

    // Tracked rank keywords (Phase 2) -----------------------------------------
    if (action === "rank-keyword.add") {
      const parsed = parseTrackedRankKeywordInput(body?.trackedRankKeyword);
      if (!parsed.ok) return validationError(parsed.error, cors);
      const input = parsed.value;

      const { count, error: countError } = await admin
        .from("tracked_rank_keywords")
        .select("id", { count: "exact", head: true })
        .eq("site_id", input.siteId);
      if (countError) throw countError;
      if ((count ?? 0) >= MAX_TRACKED_RANK_KEYWORDS_PER_SITE) {
        return json(
          409,
          {
            ok: false,
            error: "limit_reached",
            message: `A site may track at most ${MAX_TRACKED_RANK_KEYWORDS_PER_SITE} rank keywords.`,
          },
          cors,
        );
      }

      const { error } = await admin.from("tracked_rank_keywords").upsert(
        {
          site_id: input.siteId,
          query: input.query,
          engine: input.engine,
          device: input.device,
          country: input.country,
          location: input.location,
        },
        {
          onConflict: "site_id,query,engine,device,country_key,location_key",
          ignoreDuplicates: true,
        },
      );
      if (error) throw error;
      return json(200, { ok: true }, cors);
    }

    if (action === "rank-keyword.remove") {
      const parsed = parseRemoveTrackedRankKeywordInput(
        body?.trackedRankKeyword,
      );
      if (!parsed.ok) return validationError(parsed.error, cors);
      const { error } = await admin
        .from("tracked_rank_keywords")
        .delete()
        .eq("id", parsed.value.id);
      if (error) throw error;
      return json(200, { ok: true }, cors);
    }

    // Rank observations (Phase 2) ---------------------------------------------
    // A single manual rank check for one tracked keyword - the "we don't run a
    // paid/automated SERP scraper" path CLAUDE.md and the Phase 2 brief call
    // for. Recorded with source='manual' so the UI never confuses it with an
    // automated observation.
    if (action === "rank-observation.record") {
      const parsed = parseRankObservationInput(body?.observation);
      if (!parsed.ok) return validationError(parsed.error, cors);
      const input = parsed.value;

      const { data: keyword, error: keywordError } = await admin
        .from("tracked_rank_keywords")
        .select("site_id, query, engine, device, country, location")
        .eq("id", input.trackedRankKeywordId)
        .maybeSingle();
      if (keywordError) throw keywordError;
      if (!keyword) {
        return json(
          404,
          {
            ok: false,
            error: "not_found",
            message: "Tracked keyword not found.",
          },
          cors,
        );
      }

      const { error } = await admin.from("rank_snapshots").insert({
        site_id: keyword.site_id,
        query: keyword.query,
        engine: keyword.engine,
        device: keyword.device,
        country: keyword.country,
        location: keyword.location,
        ranking_url: input.rankingUrl,
        observed_rank: input.observedRank,
        source: "manual",
      });
      if (error) throw error;
      return json(200, { ok: true }, cors);
    }

    // A full observed-SERP entry: the admin records what they actually saw on
    // a real Google/Bing results page for a tracked keyword - every domain
    // present, not just our own. This is the zero-cost source for both our
    // own "observed rank" (source='observed_serp') and the Observed Keyword
    // Gap competitor data, without an automated scraper hitting a live SERP.
    if (action === "serp-observation.record") {
      const parsed = parseSerpObservationInput(body?.observation);
      if (!parsed.ok) return validationError(parsed.error, cors);
      const input = parsed.value;

      const { data: keyword, error: keywordError } = await admin
        .from("tracked_rank_keywords")
        .select("site_id, query, engine, device, country, location")
        .eq("id", input.trackedRankKeywordId)
        .maybeSingle();
      if (keywordError) throw keywordError;
      if (!keyword) {
        return json(
          404,
          {
            ok: false,
            error: "not_found",
            message: "Tracked keyword not found.",
          },
          cors,
        );
      }

      const observedAt = new Date().toISOString();
      const { error: serpError } = await admin
        .from("observed_serp_results")
        .insert(
          input.results.map((r) => ({
            site_id: keyword.site_id,
            query: keyword.query,
            engine: keyword.engine,
            observed_at: observedAt,
            domain: r.domain,
            url: r.url,
            rank_observed: r.rankObserved,
            is_own_site: r.isOwnSite,
          })),
        );
      if (serpError) throw serpError;

      const ownResult = input.results.find((r) => r.isOwnSite);
      if (ownResult) {
        const { error: snapshotError } = await admin
          .from("rank_snapshots")
          .insert({
            site_id: keyword.site_id,
            query: keyword.query,
            engine: keyword.engine,
            device: keyword.device,
            country: keyword.country,
            location: keyword.location,
            ranking_url: ownResult.url,
            observed_rank: ownResult.rankObserved,
            source: "observed_serp",
          });
        if (snapshotError) throw snapshotError;
      }

      return json(200, { ok: true }, cors);
    }

    // Competitor domains (Phase 2) ---------------------------------------------
    if (action === "competitor-domain.add") {
      const parsed = parseCompetitorDomainInput(body?.competitorDomain);
      if (!parsed.ok) return validationError(parsed.error, cors);
      const input = parsed.value;

      const { count, error: countError } = await admin
        .from("competitor_domains")
        .select("id", { count: "exact", head: true })
        .eq("site_id", input.siteId);
      if (countError) throw countError;
      if ((count ?? 0) >= MAX_COMPETITOR_DOMAINS_PER_SITE) {
        return json(
          409,
          {
            ok: false,
            error: "limit_reached",
            message: `A site may track at most ${MAX_COMPETITOR_DOMAINS_PER_SITE} competitor domains.`,
          },
          cors,
        );
      }

      const { error } = await admin.from("competitor_domains").upsert(
        {
          site_id: input.siteId,
          domain: input.domain,
          label: input.label,
          note: input.note,
          auto_discovered: input.autoDiscovered,
        },
        { onConflict: "site_id,domain" },
      );
      if (error) throw error;
      return json(200, { ok: true }, cors);
    }

    if (action === "competitor-domain.remove") {
      const parsed = parseRemoveCompetitorDomainInput(body?.competitorDomain);
      if (!parsed.ok) return validationError(parsed.error, cors);
      const { error } = await admin
        .from("competitor_domains")
        .delete()
        .eq("site_id", parsed.value.siteId)
        .eq("domain", parsed.value.domain);
      if (error) throw error;
      return json(200, { ok: true }, cors);
    }

    return validationError("Unknown action", cors);
  } catch (err) {
    const normalized = normalizeError(err);
    const status =
      normalized.status && normalized.status >= 400 && normalized.status < 600
        ? normalized.status
        : 500;
    return json(
      status,
      { ok: false, error: normalized.code, message: normalized.message },
      cors,
    );
  }
});
