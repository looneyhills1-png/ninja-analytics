import { preflight, corsHeaders } from "../_shared/cors.ts";
import { json } from "../_shared/response.ts";
import { requireAdminMfa } from "../_shared/auth.ts";
import { normalizeError } from "../_shared/errors.ts";
import { parseSiteInput } from "../_shared/site-input.ts";
import { isUuid } from "../_shared/validate.ts";
import {
  changedExistingProperties,
  findDuplicateAssignment,
  resolveEnabled,
  validateIntegrations,
  type IntegrationIds,
} from "../_shared/site-integrations.ts";

const SITE_COLUMNS =
  "id,name,domain,website_url,gsc_property,ga4_property_id,bing_site_url,is_active,created_at,updated_at";

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

    // Delete cascades to metrics, sync history, and integration_status.
    if (action === "delete") {
      const id = body?.id;
      if (!isUuid(id)) {
        return json(
          400,
          {
            ok: false,
            error: "validation_error",
            message: "Valid site id required",
          },
          cors,
        );
      }
      const { error } = await admin.from("sites").delete().eq("id", id);
      if (error) throw error;
      return json(200, { ok: true }, cors);
    }

    if (action !== "create" && action !== "update") {
      return json(
        400,
        { ok: false, error: "validation_error", message: "Unknown action" },
        cors,
      );
    }

    const parsed = parseSiteInput(body?.site);
    if (!parsed.ok) {
      return json(
        400,
        { ok: false, error: "validation_error", message: parsed.error },
        cors,
      );
    }
    const input = parsed.value;
    const ids: IntegrationIds = {
      gsc_property: input.gsc_property,
      ga4_property_id: input.ga4_property_id,
      bing_site_url: input.bing_site_url,
    };

    // Each identifier must belong to this site's own host / be well formed.
    const valid = validateIntegrations(ids, input.domain);
    if (!valid.ok) {
      return json(
        400,
        {
          ok: false,
          error: "validation_error",
          field: valid.field,
          message: valid.error,
        },
        cors,
      );
    }

    // A property may only be assigned to one site.
    const targetId = action === "update" ? body?.id : null;
    const { data: others, error: othersError } = await admin
      .from("sites")
      .select("id,name,gsc_property,ga4_property_id,bing_site_url");
    if (othersError) throw othersError;
    const dup = findDuplicateAssignment(
      ids,
      (others ?? []).filter((o) => o.id !== targetId),
    );
    if (dup) {
      return json(
        409,
        {
          ok: false,
          error: "property_in_use",
          provider: dup.provider,
          message: `That ${dup.provider.toUpperCase()} property is already assigned to ${dup.siteName}.`,
        },
        cors,
      );
    }
    const requested = body?.integrations as
      | Partial<Record<"gsc" | "ga4" | "bing", unknown>>
      | undefined;
    const enabled = resolveEnabled(ids, requested);
    const applyEnabled = async (siteId: string) => {
      for (const source of ["gsc", "ga4", "bing"] as const) {
        await admin
          .from("integration_status")
          .update({ enabled: enabled[source] })
          .eq("site_id", siteId)
          .eq("source", source);
      }
    };

    if (action === "create") {
      const { data, error } = await admin
        .from("sites")
        .insert(input)
        .select(SITE_COLUMNS)
        .single();
      if (error) {
        if (error.code === "23505") {
          return json(
            409,
            {
              ok: false,
              error: "domain_exists",
              message: "That domain is already tracked.",
            },
            cors,
          );
        }
        throw error;
      }
      await applyEnabled(data.id);
      return json(200, { ok: true, site: data }, cors);
    }

    // update
    const id = body?.id;
    if (!isUuid(id)) {
      return json(
        400,
        {
          ok: false,
          error: "validation_error",
          message: "Valid site id required",
        },
        cors,
      );
    }

    // Replacing a property that already has history would blend two
    // properties' data under one site, so it needs explicit confirmation.
    const { data: current } = await admin
      .from("sites")
      .select("gsc_property,ga4_property_id,bing_site_url")
      .eq("id", id)
      .maybeSingle();
    if (current) {
      const changed = changedExistingProperties(current as IntegrationIds, ids);
      if (changed.length > 0 && body?.confirmPropertyChange !== true) {
        return json(
          409,
          {
            ok: false,
            error: "property_change_requires_confirmation",
            providers: changed,
            message:
              "Changing a property that already has stored history mixes the old and new data. Confirm to proceed.",
          },
          cors,
        );
      }
    }

    const { data, error } = await admin
      .from("sites")
      .update(input)
      .eq("id", id)
      .select(SITE_COLUMNS)
      .maybeSingle();
    if (error) {
      if (error.code === "23505") {
        return json(
          409,
          {
            ok: false,
            error: "domain_exists",
            message: "That domain is already tracked.",
          },
          cors,
        );
      }
      throw error;
    }
    if (!data) return json(404, { ok: false, error: "not_found" }, cors);

    await applyEnabled(id as string);

    return json(200, { ok: true, site: data }, cors);
  } catch (err) {
    const n = normalizeError(err);
    return json(
      n.status ?? 500,
      { ok: false, error: n.code, message: n.message },
      cors,
    );
  }
});
