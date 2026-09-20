import { useMemo } from "react";
import { useCompetitorDomains, useSite } from "@/lib/hooks";
import { usePrivacyMode } from "@/lib/privacy";
import { EmptyState } from "@/components/ui/empty-state";

/** Domain picker shared by the Common Crawl tabs (Historical Pages,
 * New/Lost Pages, Links): our own site's domain plus every tracked
 * competitor domain. */
export function useDomainOptions(siteId: string) {
  const siteQuery = useSite(siteId);
  const domainsQuery = useCompetitorDomains(siteId);
  return useMemo(() => {
    const options: string[] = [];
    if (siteQuery.data?.domain) options.push(siteQuery.data.domain);
    for (const c of domainsQuery.data ?? []) {
      if (!options.includes(c.domain)) options.push(c.domain);
    }
    return options;
  }, [siteQuery.data, domainsQuery.data]);
}

export function DomainPicker({
  domains,
  value,
  onChange,
}: {
  domains: string[];
  value: string | null;
  onChange: (domain: string) => void;
}) {
  const privacy = usePrivacyMode();
  if (domains.length === 0) {
    return (
      <EmptyState
        title="No domains yet"
        description="Add a competitor domain in Overview first."
      />
    );
  }
  return (
    <select
      value={value ?? domains[0]}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 rounded-md border border-border bg-card px-2 text-sm"
    >
      {domains.map((d) => (
        <option key={d} value={d}>
          {privacy.enabled ? privacy.maskText(d, `domain-opt:${d}`) : d}
        </option>
      ))}
    </select>
  );
}
