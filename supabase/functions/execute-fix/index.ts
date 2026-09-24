// execute-fix (PART 1, 2026-09-24 brief): the real, automated Fix action
// behind Ninja Analytics' "Fix" button. Admin+aal2 triggered (same trust
// model as inspect-urls/manual-sync). Sequence:
//   inspect (fetch the real guides.json entry + the generator-controlled
//   manifest, both from ninjatickets' own source of truth) -> validate
//   (fix-validation.ts's evidence/safety gates) -> edit + commit (GitHub
//   Contents API, single guides.json commit) -> return. Everything from
//   "deploying" onward (CI, live verification, sitemap resubmission, recrawl
//   monitoring) is handled by advance-fix-runs on its own schedule - this
//   function never blocks waiting for a multi-minute CI run.
//
// v1 scope: the only fix type that can be auto-executed is a CTR-first meta
// description refresh (see fix-validation.ts's header comment for why).
// Every other suggestion is recorded, not executed.
import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError, SyncError } from "../_shared/errors.ts";
import {
  getGithubPat,
  getFile,
  putFile,
  fetchGeneratorControlledManifest,
  type RepoRef,
} from "../_shared/github-api.ts";
import {
  validateFixPlan,
  type EvidenceSnapshot,
} from "../_shared/fix-validation.ts";

const REPO: RepoRef = {
  owner: "looneyhills1-png",
  repo: "ninjatickets",
  branch: "main",
};
const GUIDES_PATH = "src/data/guides.json";

interface GuideEntry {
  slug: string;
  metaDescription?: string;
  [key: string]: unknown;
}

function slugFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const cors = corsHeaders(req);

  try {
    if (req.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, cors);
    }
    const { admin, userId } = await requireAdminMfa(req);

    const body = (await req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const siteId = body?.siteId;
    const query = body?.query;
    const url = body?.url;
    const currentPosition =
      typeof body?.currentPosition === "number" ? body.currentPosition : null;
    const impressions =
      typeof body?.impressions === "number" ? body.impressions : 0;
    const clicks = typeof body?.clicks === "number" ? body.clicks : 0;
    const ctr = typeof body?.ctr === "number" ? body.ctr : null;
    const categories = Array.isArray(body?.categories)
      ? (body!.categories as unknown[]).filter(
          (c): c is string => typeof c === "string",
        )
      : [];

    if (
      typeof siteId !== "string" ||
      typeof query !== "string" ||
      typeof url !== "string" ||
      !siteId ||
      !query ||
      !url
    ) {
      return json(
        400,
        {
          ok: false,
          error: "validation_error",
          message: "siteId, query and url are required",
        },
        cors,
      );
    }

    const { data: site, error: siteError } = await admin
      .from("sites")
      .select("id, domain")
      .eq("id", siteId)
      .maybeSingle();
    if (siteError) throw siteError;
    if (!site) return json(404, { ok: false, error: "not_found" }, cors);

    const evidence: EvidenceSnapshot = {
      query,
      url,
      currentPosition,
      impressions,
      clicks,
      ctr,
      categories,
    };

    // 1. Create the audit-trail row up front, state diagnosis_ready -
    // exists even if everything after this fails, per the brief's audit
    // requirement.
    const { data: run, error: insertError } = await admin
      .from("fix_runs")
      .insert({
        site_id: siteId,
        query,
        url,
        state: "validating",
        evidence,
        created_by: userId,
      })
      .select()
      .single();
    if (insertError) throw insertError;

    const slug = slugFromUrl(url);
    if (!slug) {
      await admin
        .from("fix_runs")
        .update({
          state: "rejected",
          rejected_fixes: [
            {
              type: "meta_description",
              reason: "Could not derive a guide slug from the URL.",
            },
          ],
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id);
      return json(
        200,
        { ok: true, fixRun: { ...run, state: "rejected" } },
        cors,
      );
    }

    // 2. Inspect: the real source-of-truth generator manifest + the real
    // current guides.json entry - never trust the client's own idea of
    // "current" content.
    const [manifest] = await Promise.all([
      fetchGeneratorControlledManifest(site.domain),
    ]);

    const token = getGithubPat();
    const guidesFile = await getFile(token, REPO, GUIDES_PATH);
    let guides: GuideEntry[];
    try {
      guides = JSON.parse(guidesFile.content);
    } catch {
      throw new SyncError(
        "provider_error",
        "guides.json did not parse as JSON",
      );
    }
    const guideIndex = guides.findIndex((g) => g.slug === slug);
    const currentMetaDescription =
      guideIndex >= 0 ? (guides[guideIndex].metaDescription ?? null) : null;

    // 3. Validate.
    const validation = validateFixPlan({
      evidence,
      slug,
      currentMetaDescription,
      generatorControlled: manifest.guides,
    });

    if (validation.approved.length === 0) {
      const { data: updated } = await admin
        .from("fix_runs")
        .update({
          state: "rejected",
          rejected_fixes: validation.rejected,
          updated_at: new Date().toISOString(),
        })
        .eq("id", run.id)
        .select()
        .single();
      return json(
        200,
        { ok: true, fixRun: updated ?? { ...run, state: "rejected" } },
        cors,
      );
    }

    // 4. Edit + commit (single file, single commit - "one coherent commit").
    const fix = validation.approved[0];
    guides[guideIndex] = {
      ...guides[guideIndex],
      metaDescription: fix.newValue,
    };
    const newContent = JSON.stringify(guides, null, 2) + "\n";

    const commitMessage = `SEO Fix: refresh meta description for ${slug}\n\nAutomated Fix run ${run.id} - CTR-first opportunity for query "${query}" (position ${currentPosition ?? "?"}, ${impressions} impressions, ${clicks} clicks).\n\nGenerated by Ninja Analytics Fix workflow.`;
    const putResult = await putFile(
      token,
      REPO,
      GUIDES_PATH,
      newContent,
      guidesFile.sha,
      commitMessage,
    );

    const { data: updated, error: updateError } = await admin
      .from("fix_runs")
      .update({
        state: "deploying",
        proposed_fixes: validation.approved,
        rejected_fixes: validation.rejected,
        files_changed: [{ path: GUIDES_PATH, before_sha: guidesFile.sha }],
        commit_sha: putResult.commitSha,
        commit_url: putResult.commitUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("id", run.id)
      .select()
      .single();
    if (updateError) throw updateError;

    return json(200, { ok: true, fixRun: updated }, cors);
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
