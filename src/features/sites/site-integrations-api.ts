import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";

export type IntegrationProvider = "gsc" | "ga4" | "bing";

export type CheckStatus =
  | "ok"
  | "stale_credentials"
  | "missing_permission"
  | "api_disabled"
  | "not_found"
  | "invalid_input"
  | "not_configured"
  | "error";

export interface ProviderResult {
  status: CheckStatus;
  message: string;
}

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

export interface DiscoveryResult {
  providers: Record<IntegrationProvider, ProviderResult>;
  candidates: {
    gsc: GscCandidate[];
    ga4: Ga4Candidate[];
    bing: BingCandidate[];
  };
  suggested: {
    gsc: GscCandidate[];
    ga4: Ga4Candidate[];
    bing: BingCandidate[];
  } | null;
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(
    "site-integrations",
    { body },
  );
  if (error || !data) {
    throw new Error("The request failed. Please try again.");
  }
  return data;
}

export const discoverProperties = (domain: string) =>
  call<DiscoveryResult & { ok: boolean }>({ action: "discover", domain });

export async function testConnection(
  provider: IntegrationProvider,
  value: string,
  domain: string,
): Promise<ProviderResult> {
  const r = await call<{ ok: boolean; result: ProviderResult }>({
    action: "test",
    provider,
    value,
    domain,
  });
  return r.result;
}

export const useDiscoverProperties = () =>
  useMutation({ mutationFn: discoverProperties });

export const useTestConnection = () =>
  useMutation({
    mutationFn: (v: {
      provider: IntegrationProvider;
      value: string;
      domain: string;
    }) => testConnection(v.provider, v.value, v.domain),
  });
