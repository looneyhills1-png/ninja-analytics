// Outbound-request guard for probes that fetch owner-configured website URLs
// (uptime, sitemap discovery). It keeps those requests on the public web:
//
//   * hostnames must look public (no localhost, single-label, .local, ...),
//     IP literals, userinfo and non-default ports are refused
//   * the hostname's DNS answers must all be public addresses, checked before
//     the first request and again for every redirect hop
//   * redirects are followed by hand (max MAX_REDIRECTS) so each hop is
//     validated; an unsafe hop stops the request
//
// Limit, stated plainly: fetch() resolves DNS again itself, so a hostile DNS
// server could answer differently between our check and the connection
// (rebinding). Closing that needs egress filtering or a DNS-pinned client; this
// guard removes the practical cases (internal names, literal IPs, redirects to
// metadata or loopback, names that resolve to private ranges).
//
// No Deno or npm imports at module level so Vitest can run it directly.

export const MAX_REDIRECTS = 5;

export class UnsafeUrlError extends Error {
  constructor(
    public reason:
      | "blocked_url"
      | "blocked_redirect"
      | "too_many_redirects"
      | "unresolvable",
    message: string,
  ) {
    super(message);
  }
}

const INTERNAL_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home",
  "test",
  "invalid",
  "example",
  "onion",
  "arpa",
];
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** True for loopback, private, link-local, CGNAT, multicast and reserved IPs. */
export function isPrivateIp(ip: string): boolean {
  const v = ip
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v.includes(":")) {
    if (v === "::" || v === "::1") return true;
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateIp(mapped[1]);
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return (
      /^f[cd]/.test(v) || // fc00::/7 unique local
      /^fe[89ab]/.test(v) || // fe80::/10 link-local
      v.startsWith("ff") || // multicast
      v.startsWith("2001:db8") // documentation
    );
  }
  return true; // not an address we understand: treat as unsafe
}

/** Parse and apply the static (no network) rules; null means refuse. */
export function publicUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.startsWith("[")) return null;
  // URL normalises 0x7f000001 / 0177.0.0.1 to dotted form, so one test covers
  // every alternate IPv4 spelling.
  if (/^\d+(?:\.\d+){3}$/.test(host)) return null;
  if (!host.includes(".")) return null;
  if (INTERNAL_SUFFIXES.includes(host)) return null;
  if (INTERNAL_SUFFIXES.some((s) => host.endsWith(`.${s}`))) return null;
  if (host.split(".").some((l) => !LABEL.test(l))) return null;
  return url;
}

export type DnsResolver = (
  host: string,
  type: "A" | "AAAA",
) => Promise<string[]>;

/** Default resolver: Deno's, when the runtime provides it. */
export function defaultResolver(): DnsResolver | null {
  const d = (globalThis as { Deno?: { resolveDns?: unknown } }).Deno;
  if (!d || typeof d.resolveDns !== "function") return null;
  return (host, type) =>
    (d.resolveDns as (h: string, t: string) => Promise<string[]>)(host, type);
}

/**
 * Refuse hosts whose DNS answers include any private address. With no resolver
 * (or when a record type does not exist) only the static rules apply; a host
 * that resolves to nothing at all is reported as unresolvable.
 */
export async function assertResolvesPublic(
  host: string,
  resolver: DnsResolver | null = defaultResolver(),
): Promise<void> {
  if (!resolver) return;
  const answers: string[] = [];
  let anyOk = false;
  for (const type of ["A", "AAAA"] as const) {
    try {
      answers.push(...(await resolver(host, type)));
      anyOk = true;
    } catch {
      // No record of this type (or lookup failed); judged on the other.
    }
  }
  if (!anyOk || answers.length === 0)
    throw new UnsafeUrlError("unresolvable", "Hostname did not resolve.");
  if (answers.some(isPrivateIp))
    throw new UnsafeUrlError(
      "blocked_url",
      "Hostname resolves to a private address.",
    );
}

export interface FetchPublicOptions {
  resolver?: DnsResolver | null;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
}

/**
 * fetch() for public websites. Validates the URL and every redirect hop;
 * returns the final response plus the hop count.
 */
export async function fetchPublic(
  raw: string | URL,
  init: Omit<RequestInit, "redirect"> = {},
  opts: FetchPublicOptions = {},
): Promise<{ response: Response; redirects: number; finalUrl: string }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const limit = opts.maxRedirects ?? MAX_REDIRECTS;
  let current = publicUrl(String(raw));
  if (!current)
    throw new UnsafeUrlError("blocked_url", "URL is not a public web address.");
  for (let hop = 0; ; hop++) {
    await assertResolvesPublic(
      current.hostname.toLowerCase().replace(/\.$/, ""),
      opts.resolver === undefined ? defaultResolver() : opts.resolver,
    );
    const res = await doFetch(current.href, { ...init, redirect: "manual" });
    const location =
      res.status >= 300 && res.status < 400
        ? res.headers.get("location")
        : null;
    if (!location)
      return { response: res, redirects: hop, finalUrl: current.href };
    await res.body?.cancel();
    if (hop >= limit)
      throw new UnsafeUrlError("too_many_redirects", "Too many redirects.");
    let next: URL | null;
    try {
      next = publicUrl(new URL(location, current).href);
    } catch {
      next = null;
    }
    if (!next)
      throw new UnsafeUrlError(
        "blocked_redirect",
        "Redirect points somewhere that is not a public web address.",
      );
    current = next;
  }
}
