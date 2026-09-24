// advance-fix-runs (PART 1, 2026-09-24 brief): scheduled (pg_cron, every 15
// minutes - see migration 0019's invoke_advance_fix_runs) state-machine
// advancement for in-flight Fix runs. Immediately no-ops (zero HTTP calls,
// zero GitHub/Google API usage) when there are no active fix_runs, so an
// idle portfolio costs nothing - "no wasteful deploy polling" / "URL
// Inspection quota must be respected" (CLAUDE.md).
//
// deploying -> checks the GitHub Actions run for the commit; on success,
//   fetches the LIVE page and confirms the intended change is actually
//   there (never marks a Fix complete just because the commit succeeded),
//   then resubmits the sitemap (Sitemaps API, never the Indexing API).
// awaiting_recrawl -> re-runs URL Inspection (quota-respecting, via the same
//   inspectAndStoreUrls helper the on-demand Indexing page uses) and checks
//   whether Google's lastCrawlTime is now later than this Fix's deploy.
import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAutomationSecret } from "../_shared/auth.ts";
import { createAdminClient, type SupabaseClient } from "../_shared/database.ts";
import { normalizeError } from "../_shared/errors.ts";
import {
  getGithubPat,
  findWorkflowRunForCommit,
  type RepoRef,
} from "../_shared/github-api.ts";
import { submitSitemap } from "../_shared/google-sitemaps.ts";
import { inspectAndStoreUrls } from "../_shared/gsc-url-inspection.ts";

const REPO: RepoRef = {
  owner: "looneyhills1-png",
  repo: "ninjatickets",
  branch: "main",
};
const WORKFLOW_FILE = "guide-publishing-deploy.yml";

async function advanceDeploying(
  admin: SupabaseClient,
  run: Record<string, unknown>,
) {
  const token = getGithubPat();
  const runStatus = await findWorkflowRunForCommit(
    token,
    REPO,
    WORKFLOW_FILE,
    run.commit_sha as string,
  );
  if (!runStatus) return; // Actions run hasn't appeared yet - check again next tick

  if (runStatus.status !== "completed") {
    await admin
      .from("fix_runs")
      .update({
        github_run_id: runStatus.id,
        github_run_url: runStatus.htmlUrl,
        deployment_result: {
          status: runStatus.status,
          conclusion: runStatus.conclusion,
          checkedAt: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id as string);
    return;
  }

  if (runStatus.conclusion !== "success") {
    await admin
      .from("fix_runs")
      .update({
        state: "failed",
        github_run_id: runStatus.id,
        github_run_url: runStatus.htmlUrl,
        deployment_result: {
          status: runStatus.status,
          conclusion: runStatus.conclusion,
          checkedAt: new Date().toISOString(),
        },
        error_message: `GitHub Actions build/deploy run concluded "${runStatus.conclusion}" - see ${runStatus.htmlUrl}`,
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id as string);
    return;
  }

  // Deploy succeeded - verify the LIVE page, never trust the commit alone.
  const url = run.url as string;
  const proposed = (run.proposed_fixes as Array<{ newValue?: string }>) ?? [];
  const expected = proposed[0]?.newValue;
  let matches = false;
  let fetchError: string | null = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "ninja-analytics-fix-verify" },
    });
    if (res.ok) {
      const html = await res.text();
      matches = !!expected && html.includes(expected);
    } else {
      fetchError = `Live page returned HTTP ${res.status}`;
    }
  } catch (e) {
    fetchError = (e as Error).message;
  }

  const now = new Date().toISOString();
  if (!matches) {
    await admin
      .from("fix_runs")
      .update({
        state: "failed",
        github_run_id: runStatus.id,
        github_run_url: runStatus.htmlUrl,
        deployment_result: {
          status: runStatus.status,
          conclusion: runStatus.conclusion,
          checkedAt: now,
        },
        live_verification: {
          checkedAt: now,
          matches: false,
          error: fetchError,
        },
        error_message: fetchError
          ? `Could not verify the live page: ${fetchError}`
          : "Live page did not contain the intended change after a successful deploy - Fix not marked complete.",
        updated_at: now,
      })
      .eq("id", run.id as string);
    return;
  }

  // Resubmit the sitemap (Sitemaps API - never the Indexing API for ordinary
  // pages) now that a material production change has actually landed live.
  const { data: site } = await admin
    .from("sites")
    .select("gsc_property, website_url")
    .eq("id", run.site_id as string)
    .maybeSingle();
  const gscProperty = site?.gsc_property as string | undefined;
  const sitemapUrl = `${(site?.website_url as string | undefined)?.replace(/\/$/, "") ?? "https://ninjatickets.com"}/sitemap.xml`;

  let sitemapResult: { ok: boolean; status: number; error?: string } = {
    ok: false,
    status: 0,
    error: "No gsc_property configured for this site",
  };
  if (gscProperty) {
    sitemapResult = await submitSitemap(gscProperty, sitemapUrl);
    await admin.from("sitemap_submissions").insert({
      site_id: run.site_id as string,
      fix_run_id: run.id as string,
      sitemap_url: sitemapUrl,
      submitted_at: now,
      submit_ok: sitemapResult.ok,
      submit_status: sitemapResult.status,
      submit_error: sitemapResult.error ?? null,
    });
  }

  await admin
    .from("fix_runs")
    .update({
      state: "awaiting_recrawl",
      github_run_id: runStatus.id,
      github_run_url: runStatus.htmlUrl,
      deployment_result: {
        status: runStatus.status,
        conclusion: runStatus.conclusion,
        checkedAt: now,
      },
      live_verification: { checkedAt: now, matches: true },
      sitemap_submission_result: sitemapResult,
      deployed_at: now,
      updated_at: now,
    })
    .eq("id", run.id as string);
}

async function advanceAwaitingRecrawl(
  admin: SupabaseClient,
  run: Record<string, unknown>,
) {
  const { data: site } = await admin
    .from("sites")
    .select("gsc_property")
    .eq("id", run.site_id as string)
    .maybeSingle();
  const gscProperty = site?.gsc_property as string | undefined;
  if (!gscProperty) return;

  // Quota-respecting: the same helper the on-demand Indexing page uses,
  // which skips a URL re-inspected within the last 20 hours unless forced.
  await inspectAndStoreUrls(admin, run.site_id as string, gscProperty, [
    run.url as string,
  ]);

  const { data: inspection } = await admin
    .from("url_inspections")
    .select("last_crawl_time, ninja_status, raw_response")
    .eq("site_id", run.site_id as string)
    .eq("url", run.url as string)
    .maybeSingle();
  if (!inspection?.last_crawl_time) return;

  const deployedAt = run.deployed_at as string | null;
  if (!deployedAt) return;
  const recrawled = new Date(inspection.last_crawl_time) > new Date(deployedAt);
  if (!recrawled) return;

  const indexed = inspection.ninja_status === "indexed";
  await admin
    .from("fix_runs")
    .update({
      state: indexed ? "indexed" : "recrawled",
      crawl_time_after: inspection.last_crawl_time,
      google_inspection_after: inspection.raw_response,
      updated_at: new Date().toISOString(),
    })
    .eq("id", run.id as string);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    requireAutomationSecret(req);
    const admin = createAdminClient();

    const { data: activeRuns, error } = await admin
      .from("fix_runs")
      .select("*")
      .in("state", ["deploying", "awaiting_recrawl"])
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw error;

    if (!activeRuns || activeRuns.length === 0) {
      return json(
        200,
        { ok: true, processed: 0, note: "no active fix_runs" },
        cors,
      );
    }

    let processed = 0;
    for (const run of activeRuns) {
      try {
        if (run.state === "deploying") {
          await advanceDeploying(admin, run as Record<string, unknown>);
        } else if (run.state === "awaiting_recrawl") {
          await advanceAwaitingRecrawl(admin, run as Record<string, unknown>);
        }
        processed++;
      } catch (err) {
        const n = normalizeError(err);
        await admin
          .from("fix_runs")
          .update({
            error_message: `advance-fix-runs: ${n.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", run.id as string);
      }
    }

    return json(200, { ok: true, processed }, cors);
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
