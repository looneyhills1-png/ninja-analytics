// Pure helpers for editing a site's provider integrations: identifier
// validation (format + ownership of the host), duplicate / property-change
// guards, and parsing of provider discovery responses. No Deno or npm imports,
// so Vitest can exercise it. Provider credentials never pass through here.

export type Provider = "gsc" | "ga4" | "bing";

export interface IntegrationIds {
  gsc_property: string | null;
  ga4_property_id: string | null;
  bing_site_url: string | null;
}

const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return bare(u.hostname);
  } catch {
    return null;
  }
}

/** A provider identifier may only point at the site's own host, which stops a
 * property of one site being assigned to another. */
export function validateGscProperty(
  value: string,
  domain: string,
): { ok: true; kind: "domain" | "url-prefix" } | { ok: false; error: string } {
  const d = bare(domain);
  if (value.startsWith("sc-domain:")) {
    const host = bare(value.slice("sc-domain:".length));
    if (host !== d) {
      return {
        ok: false,
        error: `GSC domain property must be sc-domain:${d} for this site.`,
      };
    }
    return { ok: true, kind: "domain" };
  }
  const host = hostOf(value);
  if (!host) {
    return {
      ok: false,
      error:
        "GSC property must be sc-domain:example.com or a full URL such as https://example.com/",
    };
  }
  if (host !== d) {
    return { ok: false, error: `GSC property host must be ${d}.` };
  }
  return { ok: true, kind: "url-prefix" };
}

export function validateGa4PropertyId(
  value: string,
): { ok: true } | { ok: false; error: string } {
  if (/^G-/i.test(value)) {
    return {
      ok: false,
      error: "That is a measurement ID (G-…). Use the numeric property ID.",
    };
  }
  if (!/^\d{5,15}$/.test(value)) {
    return { ok: false, error: "GA4 property ID must be 5–15 digits." };
  }
  return { ok: true };
}

export function validateBingSiteUrl(
  value: string,
  domain: string,
): { ok: true } | { ok: false; error: string } {
  const host = hostOf(value);
  if (!host) {
    return { ok: false, error: "Bing site URL must start with http(s)://" };
  }
  if (host !== bare(domain)) {
    return { ok: false, error: `Bing site host must be ${bare(domain)}.` };
  }
  return { ok: true };
}

export function validateIntegrations(
  ids: IntegrationIds,
  domain: string,
): { ok: true } | { ok: false; error: string; field: string } {
  if (ids.gsc_property) {
    const r = validateGscProperty(ids.gsc_property, domain);
    if (!r.ok) return { ok: false, error: r.error, field: "gsc_property" };
  }
  if (ids.ga4_property_id) {
    const r = validateGa4PropertyId(ids.ga4_property_id);
    if (!r.ok) return { ok: false, error: r.error, field: "ga4_property_id" };
  }
  if (ids.bing_site_url) {
    const r = validateBingSiteUrl(ids.bing_site_url, domain);
    if (!r.ok) return { ok: false, error: r.error, field: "bing_site_url" };
  }
  return { ok: true };
}

const normGsc = (v: string) => v.trim().toLowerCase().replace(/\/+$/, "");
const normBing = (v: string) => v.trim().toLowerCase().replace(/\/+$/, "");

/** Returns the first other site already using one of the identifiers. */
export function findDuplicateAssignment(
  ids: IntegrationIds,
  others: Array<{ id: string; name: string } & IntegrationIds>,
): { provider: Provider; siteName: string } | null {
  for (const o of others) {
    if (
      ids.gsc_property &&
      o.gsc_property &&
      normGsc(ids.gsc_property) === normGsc(o.gsc_property)
    ) {
      return { provider: "gsc", siteName: o.name };
    }
    if (
      ids.ga4_property_id &&
      o.ga4_property_id &&
      ids.ga4_property_id === o.ga4_property_id
    ) {
      return { provider: "ga4", siteName: o.name };
    }
    if (
      ids.bing_site_url &&
      o.bing_site_url &&
      normBing(ids.bing_site_url) === normBing(o.bing_site_url)
    ) {
      return { provider: "bing", siteName: o.name };
    }
  }
  return null;
}

/** Changing a GSC/GA4 property that already has stored history would blend two
 * properties' data under one site, so it needs an explicit confirmation. */
export function changedExistingProperties(
  current: IntegrationIds,
  next: IntegrationIds,
): Provider[] {
  const out: Provider[] = [];
  if (
    current.gsc_property &&
    next.gsc_property &&
    normGsc(current.gsc_property) !== normGsc(next.gsc_property)
  ) {
    out.push("gsc");
  }
  if (
    current.ga4_property_id &&
    next.ga4_property_id &&
    current.ga4_property_id !== next.ga4_property_id
  ) {
    out.push("ga4");
  }
  if (
    current.bing_site_url &&
    next.bing_site_url &&
    normBing(current.bing_site_url) !== normBing(next.bing_site_url)
  ) {
    out.push("bing");
  }
  return out;
}

/** An integration is enabled iff the owner wants it AND an id is configured. */
export function resolveEnabled(
  ids: IntegrationIds,
  requested: Partial<Record<Provider, unknown>> | undefined,
): Record<Provider, boolean> {
  const pick = (id: string | null, flag: unknown) =>
    id != null && (flag === undefined ? true : flag === true);
  return {
    gsc: pick(ids.gsc_property, requested?.gsc),
    ga4: pick(ids.ga4_property_id, requested?.ga4),
    bing: pick(ids.bing_site_url, requested?.bing),
  };
}

// -- Discovery parsing ---------------------------------------------------------

export interface GscCandidate {
  siteUrl: string;
  permissionLevel: string;
  usable: boolean;
}
export interface Ga4Candidate {
  propertyId: string;
  displayName: string;
  account: string;
}
export interface BingCandidate {
  url: string;
  verified: boolean | null;
}

export function parseGscSites(raw: unknown): GscCandidate[] {
  const entries = (raw as { siteEntry?: unknown[] } | null)?.siteEntry;
  if (!Array.isArray(entries)) return [];
  const out: GscCandidate[] = [];
  for (const e of entries) {
    const o = e as { siteUrl?: unknown; permissionLevel?: unknown };
    if (typeof o.siteUrl !== "string") continue;
    const level =
      typeof o.permissionLevel === "string" ? o.permissionLevel : "unknown";
    out.push({
      siteUrl: o.siteUrl,
      permissionLevel: level,
      usable: level !== "siteUnverifiedUser",
    });
  }
  return out;
}

export function parseGa4AccountSummaries(raw: unknown): Ga4Candidate[] {
  const accounts = (raw as { accountSummaries?: unknown[] } | null)
    ?.accountSummaries;
  if (!Array.isArray(accounts)) return [];
  const out: Ga4Candidate[] = [];
  for (const a of accounts) {
    const acc = a as {
      displayName?: unknown;
      propertySummaries?: unknown[];
    };
    const accountName =
      typeof acc.displayName === "string" ? acc.displayName : "";
    for (const p of acc.propertySummaries ?? []) {
      const ps = p as { property?: unknown; displayName?: unknown };
      const m =
        typeof ps.property === "string"
          ? ps.property.match(/^properties\/(\d+)$/)
          : null;
      if (!m) continue;
      out.push({
        propertyId: m[1],
        displayName: typeof ps.displayName === "string" ? ps.displayName : m[1],
        account: accountName,
      });
    }
  }
  return out;
}

export function parseBingSites(raw: unknown): BingCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: BingCandidate[] = [];
  for (const s of raw) {
    const o = s as { Url?: unknown; IsVerified?: unknown };
    if (typeof o.Url !== "string") continue;
    out.push({
      url: o.Url,
      verified: typeof o.IsVerified === "boolean" ? o.IsVerified : null,
    });
  }
  return out;
}

/** Candidates that belong to this domain, for pre-selecting a dropdown. Only
 * identifiers that structurally tie to the host are suggested; GA4 properties
 * carry no domain, so they are matched on display name only and flagged as a
 * guess for the owner to confirm. */
export function suggestForDomain(
  domain: string,
  gsc: GscCandidate[],
  ga4: Ga4Candidate[],
  bing: BingCandidate[],
): {
  gsc: GscCandidate[];
  ga4: Ga4Candidate[];
  bing: BingCandidate[];
} {
  const d = bare(domain);
  const label = d.split(".")[0];
  return {
    gsc: gsc.filter((g) =>
      g.siteUrl.startsWith("sc-domain:")
        ? bare(g.siteUrl.slice(10)) === d
        : hostOf(g.siteUrl) === d,
    ),
    ga4: ga4.filter(
      (p) =>
        p.displayName.toLowerCase().includes(d) ||
        p.displayName
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .includes(label),
    ),
    bing: bing.filter((b) => hostOf(b.url) === d),
  };
}
