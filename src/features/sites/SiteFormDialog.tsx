import { HelpButton } from "@/components/ui/help-button";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { Loader2, Search, X } from "lucide-react";
import { useDeleteSite, useSaveSite } from "@/lib/hooks";
import {
  invokeManualSync,
  SaveSiteError,
  type SiteFormValues,
  type SiteWithStatuses,
} from "@/lib/api";
import type { Site } from "@/types/database";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import {
  useDiscoverProperties,
  useTestConnection,
  type DiscoveryResult,
  type IntegrationProvider,
  type ProviderResult,
} from "@/features/sites/site-integrations-api";

const PROVIDERS: IntegrationProvider[] = ["gsc", "ga4", "bing"];
const PROVIDER_LABEL: Record<IntegrationProvider, string> = {
  gsc: "Google Search Console",
  ga4: "Google Analytics 4",
  bing: "Bing Webmaster",
};
const FIELD: Record<IntegrationProvider, keyof SiteFormValues> = {
  gsc: "gsc_property",
  ga4: "ga4_property_id",
  bing: "bing_site_url",
};

function toDefaults(site?: Site): SiteFormValues {
  return {
    name: site?.name ?? "",
    domain: site?.domain ?? "",
    website_url: site?.website_url ?? "",
    gsc_property: site?.gsc_property ?? "",
    ga4_property_id: site?.ga4_property_id ?? "",
    bing_site_url: site?.bing_site_url ?? "",
    is_active: site?.is_active ?? true,
  };
}

function initialEnabled(site?: SiteWithStatuses) {
  const on = (p: IntegrationProvider) =>
    site?.statuses?.find((s) => s.source === p)?.enabled ?? true;
  return { gsc: on("gsc"), ga4: on("ga4"), bing: on("bing") };
}

const STATUS_TONE: Record<ProviderResult["status"], string> = {
  ok: "text-success",
  stale_credentials: "text-warning",
  missing_permission: "text-warning",
  api_disabled: "text-warning",
  not_found: "text-critical",
  invalid_input: "text-critical",
  not_configured: "text-muted-foreground",
  error: "text-critical",
};

export function SiteFormDialog({
  mode,
  site,
  onClose,
  onDeleted,
}: {
  mode: "create" | "edit";
  site?: Site | SiteWithStatuses;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const mutation = useSaveSite();
  const deletion = useDeleteSite();
  const discover = useDiscoverProperties();
  const test = useTestConnection();
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [enabled, setEnabled] = useState(
    initialEnabled(site as SiteWithStatuses | undefined),
  );
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [tests, setTests] = useState<
    Partial<Record<IntegrationProvider, ProviderResult>>
  >({});
  const [testing, setTesting] = useState<IntegrationProvider | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [syncResults, setSyncResults] = useState<string[] | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Guard against accidental dismissal: a click only counts as a backdrop
  // dismissal when the press *started* on the backdrop. Without this, selecting
  // text in a field and releasing the mouse outside the dialog (a drag) fires a
  // click on the backdrop and closes the form mid-edit.
  const pressStartedOnBackdrop = useRef(false);

  const handleBackdropMouseDown = (e: React.MouseEvent) => {
    pressStartedOnBackdrop.current = e.target === e.currentTarget;
  };
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && pressStartedOnBackdrop.current) {
      onClose();
    }
    pressStartedOnBackdrop.current = false;
  };

  const onDelete = () => {
    if (!site) return;
    setFormError(null);
    deletion.mutate(site.id, {
      onSuccess: () => (onDeleted ?? onClose)(),
      onError: (err) =>
        setFormError(
          err instanceof SaveSiteError
            ? err.message
            : "Could not delete the site.",
        ),
    });
  };
  const {
    register,
    handleSubmit,
    getValues,
    setValue,
    formState: { errors },
  } = useForm<SiteFormValues>({ defaultValues: toDefaults(site) });

  const save = (andSync: boolean) =>
    handleSubmit((values) => {
      setFormError(null);
      setSyncResults(null);
      mutation.mutate(
        {
          action: mode === "create" ? "create" : "update",
          id: site?.id,
          values,
          integrations: enabled,
          confirmPropertyChange: confirmed,
        },
        {
          onSuccess: async (saved) => {
            setNeedsConfirm(false);
            if (!andSync) {
              onClose();
              return;
            }
            setSyncing(true);
            const lines: string[] = [];
            for (const p of PROVIDERS) {
              if (!enabled[p] || !values[FIELD[p]]) continue;
              try {
                const res = await invokeManualSync(saved.id, p);
                const run = res.runs[0];
                lines.push(
                  run?.status === "success"
                    ? `${PROVIDER_LABEL[p]}: synced (${run.rowsWritten ?? 0} rows).`
                    : `${PROVIDER_LABEL[p]}: ${run?.status ?? "no result"}. Run Test connection, then see Sync history.`,
                );
              } catch (err) {
                lines.push(
                  `${PROVIDER_LABEL[p]}: failed${err instanceof Error ? ` (${err.message})` : ""}.`,
                );
              }
            }
            if (lines.length === 0)
              lines.push("No enabled integration to sync.");
            setSyncResults(lines);
            setSyncing(false);
          },
          onError: (err) => {
            if (
              err instanceof SaveSiteError &&
              err.code === "property_change_requires_confirmation"
            ) {
              setNeedsConfirm(true);
            }
            setFormError(
              err instanceof SaveSiteError
                ? err.message
                : "Could not save the site. Please try again.",
            );
          },
        },
      );
    })();

  const runDiscovery = () => {
    setDiscoverError(null);
    discover.mutate(getValues("domain"), {
      onSuccess: (r) => {
        setDiscovery(r);
        // Pre-fill only an empty field, and only with a structurally matched
        // suggestion - never overwrite what the owner already has.
        if (!getValues("gsc_property") && r.suggested?.gsc[0]?.usable) {
          setValue("gsc_property", r.suggested.gsc[0].siteUrl);
        }
        if (!getValues("bing_site_url") && r.suggested?.bing[0]) {
          setValue("bing_site_url", r.suggested.bing[0].url);
        }
      },
      onError: () => setDiscoverError("Discovery failed. Please try again."),
    });
  };

  const runTest = async (p: IntegrationProvider) => {
    setTesting(p);
    try {
      const result = await test.mutateAsync({
        provider: p,
        value: String(getValues(FIELD[p]) ?? "").trim(),
        domain: getValues("domain").trim().toLowerCase(),
      });
      setTests((t) => ({ ...t, [p]: result }));
    } catch {
      setTests((t) => ({
        ...t,
        [p]: { status: "error", message: "The test could not be run." },
      }));
    } finally {
      setTesting(null);
    }
  };

  const optionsFor = (p: IntegrationProvider) => {
    if (!discovery) return [];
    const suggestedKeys = new Set<string>(
      p === "gsc"
        ? (discovery.suggested?.gsc ?? []).map((c) => c.siteUrl)
        : p === "ga4"
          ? (discovery.suggested?.ga4 ?? []).map((c) => c.propertyId)
          : (discovery.suggested?.bing ?? []).map((c) => c.url),
    );
    const all =
      p === "gsc"
        ? discovery.candidates.gsc.map((c) => ({
            value: c.siteUrl,
            label: `${c.siteUrl} (${c.permissionLevel})`,
            disabled: !c.usable,
          }))
        : p === "ga4"
          ? discovery.candidates.ga4.map((c) => ({
              value: c.propertyId,
              label: `${c.displayName} · ${c.propertyId}${c.account ? ` · ${c.account}` : ""}`,
              disabled: false,
            }))
          : discovery.candidates.bing.map((c) => ({
              value: c.url,
              label: `${c.url}${c.verified === false ? " (unverified)" : ""}`,
              disabled: false,
            }));
    return all
      .map((o) => ({ ...o, suggested: suggestedKeys.has(o.value) }))
      .sort((a, b) => Number(b.suggested) - Number(a.suggested));
  };

  const busy = mutation.isPending || syncing;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onMouseDown={handleBackdropMouseDown}
      onClick={handleBackdropClick}
    >
      <div
        className="mt-10 w-full max-w-2xl rounded-lg border border-border bg-card p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "create" ? "Add site" : "Edit site"}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">
            {mode === "create" ? "Add a site" : "Edit site"}
          </h2>
          <HelpButton
            help="Closes this window without saving."
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </HelpButton>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(false);
          }}
          className="mt-4 space-y-3"
          noValidate
        >
          {formError && <Alert tone="error">{formError}</Alert>}
          {needsConfirm && (
            <label className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                I understand history already stored for the old property stays
                under this site and new data will be added to it.
              </span>
            </label>
          )}
          {syncResults && (
            <Alert tone="info">
              <ul className="space-y-0.5">
                {syncResults.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </Alert>
          )}

          <Field label="Name" error={errors.name?.message}>
            <Input
              {...register("name", { required: "Name is required" })}
              placeholder="Example Blog"
            />
          </Field>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Domain" error={errors.domain?.message}>
              <Input
                {...register("domain", { required: "Domain is required" })}
                placeholder="example.com"
              />
            </Field>
            <Field label="Website URL" error={errors.website_url?.message}>
              <Input
                {...register("website_url", {
                  required: "Website URL is required",
                })}
                placeholder="https://example.com"
              />
            </Field>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <h3 className="text-sm font-medium">Integrations</h3>
            <Button
              help="Looks up the Search Console, Analytics and Bing properties your connected accounts can see for this domain. Read-only; creates nothing."
              effect="read"
              type="button"
              variant="secondary"
              size="sm"
              disabled={discover.isPending}
              onClick={runDiscovery}
            >
              {discover.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Search className="h-4 w-4" aria-hidden />
              )}
              Discover properties
            </Button>
          </div>
          {discoverError && <Alert tone="error">{discoverError}</Alert>}

          {PROVIDERS.map((p) => {
            const options = optionsFor(p);
            const note = discovery?.providers[p];
            const result = tests[p];
            return (
              <div
                key={p}
                className="space-y-2 rounded-md border border-border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <Label>{PROVIDER_LABEL[p]}</Label>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      aria-label={`${PROVIDER_LABEL[p]} enabled`}
                      checked={enabled[p]}
                      onChange={(e) =>
                        setEnabled((s) => ({ ...s, [p]: e.target.checked }))
                      }
                    />
                    Enabled
                  </label>
                </div>
                {options.length > 0 && (
                  <select
                    aria-label={`${PROVIDER_LABEL[p]} discovered properties`}
                    className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) {
                        setValue(FIELD[p], e.target.value, {
                          shouldDirty: true,
                        });
                      }
                    }}
                  >
                    <option value="">Choose a discovered property…</option>
                    {options.map((o) => (
                      <option
                        key={o.value}
                        value={o.value}
                        disabled={o.disabled}
                      >
                        {o.suggested ? "★ " : ""}
                        {o.label}
                      </option>
                    ))}
                  </select>
                )}
                {note && note.status !== "ok" && (
                  <p className={cn("text-xs", STATUS_TONE[note.status])}>
                    {note.message}
                  </p>
                )}
                {note?.status === "ok" && options.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    Nothing accessible was found for this account.
                  </p>
                )}
                <div className="flex gap-2">
                  <Input
                    {...register(FIELD[p] as "gsc_property")}
                    placeholder={
                      p === "gsc"
                        ? "sc-domain:example.com"
                        : p === "ga4"
                          ? "483920114"
                          : "https://example.com/"
                    }
                    aria-label={`${PROVIDER_LABEL[p]} identifier`}
                  />
                  <Button
                    help="Makes one small read from this provider to prove the saved ID works. Read-only; changes nothing."
                    effect="read"
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={testing === p}
                    onClick={() => void runTest(p)}
                  >
                    {testing === p ? "Testing…" : "Test connection"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {p === "gsc"
                    ? "Domain property: sc-domain:example.com · URL-prefix: full URL"
                    : p === "ga4"
                      ? "Numeric property ID, not the G-XXXX code"
                      : "Leave blank if not using Bing"}
                </p>
                {result && (
                  <p className={cn("text-xs", STATUS_TONE[result.status])}>
                    {result.message}
                  </p>
                )}
              </div>
            );
          })}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...register("is_active")} />
            Active
          </label>

          <div className="flex items-center justify-between gap-2 pt-2">
            {mode === "edit" && site ? (
              confirmDelete ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    Delete site and all its data?
                  </span>
                  <Button
                    help="Confirms deleting this site and all its collected data from Ninja Analytics. Your real website is not touched. Backups are not affected."
                    effect="data"
                    type="button"
                    variant="danger"
                    size="sm"
                    loading={deletion.isPending}
                    onClick={onDelete}
                  >
                    Delete
                  </Button>
                  <Button
                    help="Keeps the site. Nothing is deleted."
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep
                  </Button>
                </div>
              ) : (
                <Button
                  help="Starts deleting this site from Ninja Analytics. You will be asked to confirm. Your real website is not touched."
                  effect="data"
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-critical"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete site
                </Button>
              )
            ) : (
              <span />
            )}

            <div className="flex gap-2">
              <Button
                help="Closes this window. Anything already saved stays saved."
                type="button"
                variant="ghost"
                onClick={onClose}
              >
                {syncResults ? "Done" : "Cancel"}
              </Button>
              <Button
                help="Saves these settings, then collects data once for each enabled source so you can see it work."
                effect="data"
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => void save(true)}
              >
                {syncing ? "Syncing…" : "Save & sync"}
              </Button>
              <Button
                help="Saves these website settings in Ninja Analytics."
                effect="data"
                type="submit"
                loading={mutation.isPending && !syncing}
              >
                {mode === "create" ? "Add site" : "Save changes"}
              </Button>
            </div>
          </div>
        </form>

        <p className="mt-3 text-xs text-muted-foreground">
          Saving never deletes history. Each provider syncs once on Save &amp;
          sync, then on its normal daily schedule.
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && !error && (
        <p className="text-xs text-muted-foreground">{hint}</p>
      )}
      {error && <p className="text-xs text-critical">{error}</p>}
    </div>
  );
}
