// optimise-apply: the guarded write path behind Safe Auto-Fix. Admin + MFA
// only (never callable by the automation secret). It does nothing unless:
//   * the site's mode is safe_auto (an explicit owner action),
//   * the change is on the allowlist and was marked eligible,
//   * the site has an authorised repository integration,
//   * every safeguard in _shared/optimise.ts passes.
// Applied changes are recorded in the existing fix_runs table so the existing
// advance-fix-runs job verifies the deployment, exactly as for Run Fix. Every
// step lands in optimisation_events. A rollback restores the exact backup and
// refuses if the file has changed since.

import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError, SyncError } from "../_shared/errors.ts";
import { getFile, getGithubPat, putFile } from "../_shared/github-api.ts";
import {
  applyMetaDescriptionFix,
  mayAutoApply,
  rollbackMetaDescriptionFix,
  SUPPORTED_PUBLISHERS,
  type ChangeClass,
  type OptimiseMode,
  type RepoClient,
} from "../_shared/optimise.ts";

const MAX_APPLIED_PER_SITE_PER_DAY = 3;
const DAY = 86_400_000;

function slugFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
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
    const changeId = body?.changeId;
    const action = body?.action;
    if (
      typeof changeId !== "string" ||
      !["apply", "rollback", "dismiss"].includes(String(action))
    ) {
      throw new SyncError(
        "validation_error",
        "changeId and a valid action are required",
      );
    }

    const { data: change } = await admin
      .from("optimisation_changes")
      .select("*")
      .eq("id", changeId)
      .maybeSingle();
    if (!change) throw new SyncError("validation_error", "change not found");

    const log = (event: string, detail: string) =>
      admin.from("optimisation_events").insert({
        site_id: change.site_id,
        change_id: change.id,
        actor: "owner",
        event,
        detail,
      });
    const setChange = (fields: Record<string, unknown>) =>
      admin
        .from("optimisation_changes")
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq("id", change.id);

    if (action === "dismiss") {
      if (!["proposed", "needs_approval"].includes(change.status)) {
        throw new SyncError("conflict", `Change is already ${change.status}.`);
      }
      await setChange({ status: "rejected", note: "Dismissed by the owner." });
      await log("dismissed", change.title);
      return json(200, { ok: true, status: "rejected" }, cors);
    }

    const { data: site } = await admin
      .from("sites")
      .select("id, domain")
      .eq("id", change.site_id)
      .maybeSingle();
    if (!site) throw new SyncError("validation_error", "site not found");
    const publisher =
      SUPPORTED_PUBLISHERS[String(site.domain).replace(/^www\./, "")];

    const makeClient = (): RepoClient => {
      const token = getGithubPat();
      const ref = {
        owner: publisher.owner,
        repo: publisher.repo,
        branch: publisher.branch,
      };
      return {
        getFile: (path) => getFile(token, ref, path),
        putFile: async (path, content, sha, message) => {
          const r = await putFile(token, ref, path, content, sha, message);
          return { commitSha: r.commitSha };
        },
      };
    };

    if (action === "rollback") {
      if (!["applied", "verified"].includes(change.status)) {
        throw new SyncError(
          "conflict",
          `Only an applied change can be rolled back (this one is ${change.status}).`,
        );
      }
      if (!publisher || !change.before_value?.fileContent) {
        throw new SyncError("conflict", "No backup is stored for this change.");
      }
      const result = await rollbackMetaDescriptionFix({
        client: makeClient(),
        filePath: change.file_path,
        backupContent: change.before_value.fileContent,
        appliedMetaDescription: change.after_value.metaDescription,
        slug: slugFromUrl(change.url) ?? "",
        message: `Rollback SEO fix: ${change.title}\n\nRolled back by the owner from Ninja Analytics.`,
      });
      if (!result.ok) {
        await log("rollback_refused", result.reason);
        return json(
          200,
          { ok: false, error: "rollback_refused", message: result.reason },
          cors,
        );
      }
      await setChange({
        status: "rolled_back",
        rollback_sha: result.rollbackSha,
        note: "Rolled back to the exact previous file.",
      });
      if (change.fix_run_id) {
        await admin
          .from("fix_runs")
          .update({
            state: "failed",
            error_message: "Rolled back by the owner.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", change.fix_run_id);
      }
      await log("rolled_back", `commit ${result.rollbackSha}`);
      return json(
        200,
        { ok: true, status: "rolled_back", rollbackSha: result.rollbackSha },
        cors,
      );
    }

    // ---- apply -----------------------------------------------------------
    const { data: setting } = await admin
      .from("site_optimisation")
      .select("mode")
      .eq("site_id", change.site_id)
      .maybeSingle();
    const mode = (setting?.mode ?? "monitor") as OptimiseMode;

    const refusals = mayAutoApply({
      mode,
      changeClass: change.change_class as ChangeClass,
      autoEligible: change.auto_eligible,
      changeStatus: change.status,
      hasPublisher: Boolean(publisher),
    });
    const slug = slugFromUrl(change.url);
    if (!slug)
      refusals.push("Could not work out which page this change is for.");
    const { count: appliedToday } = await admin
      .from("optimisation_changes")
      .select("id", { count: "exact", head: true })
      .eq("site_id", change.site_id)
      .in("status", ["applied", "verified"])
      .gte("updated_at", new Date(Date.now() - DAY).toISOString());
    if ((appliedToday ?? 0) >= MAX_APPLIED_PER_SITE_PER_DAY) {
      refusals.push(
        `The daily limit of ${MAX_APPLIED_PER_SITE_PER_DAY} automatic changes per site has been reached.`,
      );
    }
    if (refusals.length) {
      await log("apply_refused", refusals.join(" "));
      return json(
        200,
        { ok: false, error: "refused", reasons: refusals },
        cors,
      );
    }

    // The site's own list of generator-controlled fields. If it cannot be
    // read, refuse rather than risk editing a field that is overwritten.
    let generatorControlled: Array<{
      slug: string;
      fields: string[];
      generator: string;
    }> = [];
    try {
      const res = await fetch(
        `https://${site.domain}/assets/data/generator-controlled-fields.json`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) throw new Error(String(res.status));
      const m = (await res.json()) as { guides?: typeof generatorControlled };
      generatorControlled = Array.isArray(m.guides) ? m.guides : [];
    } catch {
      await log(
        "apply_refused",
        "Could not read the site's generator-controlled field list.",
      );
      return json(
        200,
        {
          ok: false,
          error: "refused",
          reasons: [
            "Could not read the site's generator-controlled field list, so the change was not applied.",
          ],
        },
        cors,
      );
    }

    const evidence = change.evidence as {
      query: string;
      url: string;
      currentPosition: number | null;
      impressions: number;
      clicks: number;
      ctr: number | null;
      categories: string[];
    };
    const result = await applyMetaDescriptionFix({
      client: makeClient(),
      filePath: publisher.filePath,
      slug: slug!,
      evidence,
      generatorControlled,
      commitMessage: `SEO Fix: refresh meta description for ${slug}\n\nSafe auto-fix from Ninja Analytics (optimisation change ${change.id}) for query "${evidence.query}".`,
    });
    if (!result.ok) {
      await setChange({
        status: "needs_approval",
        auto_eligible: false,
        note: `Not applied automatically: ${result.reasons.join(" ")}`,
      });
      await log("apply_refused", result.reasons.join(" "));
      return json(
        200,
        {
          ok: false,
          error: "refused",
          reasons: result.reasons,
          rejected: result.rejected,
        },
        cors,
      );
    }

    // Hand over to the existing pipeline for deployment verification.
    const { data: fixRun } = await admin
      .from("fix_runs")
      .insert({
        site_id: change.site_id,
        query: evidence.query,
        url: change.url,
        state: "deploying",
        evidence,
        proposed_fixes: [
          {
            type: "meta_description",
            slug,
            currentValue: result.applied.before.metaDescription,
            newValue: result.applied.after.metaDescription,
          },
        ],
        files_changed: [
          {
            path: publisher.filePath,
            before_sha: result.applied.before.fileSha,
          },
        ],
        commit_sha: result.applied.commitSha,
        created_by: userId,
      })
      .select("id")
      .single();
    await setChange({
      status: "applied",
      before_value: result.applied.before,
      after_value: result.applied.after,
      repo: `${publisher.owner}/${publisher.repo}`,
      file_path: publisher.filePath,
      base_sha: result.applied.before.fileSha,
      commit_sha: result.applied.commitSha,
      fix_run_id: fixRun?.id ?? null,
      note: `Safeguards passed: ${result.applied.checks.join("; ")}.`,
    });
    await log("applied", `commit ${result.applied.commitSha}`);
    return json(
      200,
      { ok: true, status: "applied", commitSha: result.applied.commitSha },
      cors,
    );
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
