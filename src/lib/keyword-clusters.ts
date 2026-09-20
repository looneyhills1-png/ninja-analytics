// Local keyword clustering (CLAUDE.md "Keyword clustering" + Phase 1
// Clusters screen). Lexical only - shared significant tokens, no embeddings
// and no external clustering API. Bounded to the top N queries by
// impressions so this stays cheap to compute in the browser on every load.

import type { KeywordOpportunityRow } from "@/lib/keyword-opportunities";

export type ClusterMapping =
  | "existing-best-url"
  | "improve-existing"
  | "potential-new-page"
  | "ignore";

export interface KeywordCluster {
  id: string;
  label: string;
  queries: KeywordOpportunityRow[];
  totalClicks: number;
  totalImpressions: number;
  bestPosition: number | null;
  rankingUrls: string[];
  mapping: ClusterMapping;
  cannibalisation: boolean;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "is",
  "are",
  "how",
  "what",
  "near",
  "me",
]);

export const CLUSTER_MAX_QUERIES = 300;
const SIMILARITY_THRESHOLD = 0.4;
const WEAK_POSITION_THRESHOLD = 10;

function tokenSet(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Simple union-find so O(n^2) similarity comparisons merge into groups
 * without repeatedly rescanning already-merged clusters. */
class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function mappingFor(
  queries: KeywordOpportunityRow[],
  rankingUrls: string[],
  bestPosition: number | null,
  totalImpressions: number,
): ClusterMapping {
  if (queries.length < 2 && totalImpressions < 20) return "ignore";
  if (rankingUrls.length === 0) return "potential-new-page";
  if (rankingUrls.length === 1) {
    return bestPosition != null && bestPosition <= WEAK_POSITION_THRESHOLD
      ? "existing-best-url"
      : "improve-existing";
  }
  // Multiple distinct URLs already sharing this cluster's queries - the
  // cluster's own opportunity rows already carry the "cannibalisation"
  // category per query; at the cluster level this means "pick one and
  // consolidate", which is the same message as improve-existing.
  return "improve-existing";
}

/**
 * Group the top-impression queries into lexical clusters and map each one to
 * a next action. Deterministic given the same input (sorted, then grouped by
 * first-touched order) so the UI doesn't reshuffle clusters between renders.
 */
export function computeKeywordClusters(
  rows: KeywordOpportunityRow[],
): KeywordCluster[] {
  const pool = [...rows]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, CLUSTER_MAX_QUERIES);
  if (pool.length === 0) return [];

  const tokens = pool.map((r) => tokenSet(r.query));
  const uf = new UnionFind(pool.length);
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      if (jaccard(tokens[i], tokens[j]) >= SIMILARITY_THRESHOLD) {
        uf.union(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < pool.length; i += 1) {
    const root = uf.find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  }

  const clusters: KeywordCluster[] = [];
  for (const [root, indices] of groups) {
    const queries = indices.map((i) => pool[i]);
    const totalClicks = queries.reduce((s, q) => s + q.clicks, 0);
    const totalImpressions = queries.reduce((s, q) => s + q.impressions, 0);
    const positions = queries
      .map((q) => q.currentPosition)
      .filter((p): p is number => p != null);
    const bestPosition = positions.length ? Math.min(...positions) : null;
    const rankingUrls = [
      ...new Set(
        queries.map((q) => q.rankingUrl).filter((u): u is string => !!u),
      ),
    ];
    const cannibalisation = rankingUrls.length >= 2;

    const sortedQueries = [...queries].sort(
      (a, b) => b.impressions - a.impressions,
    );

    // Label: the representative (highest-impression) query's own significant
    // tokens, so the label reads like a real topic rather than a random
    // member query.
    const rep = sortedQueries[0];
    const label =
      queries.length === 1
        ? rep.query
        : [...tokenSet(rep.query)].slice(0, 4).join(" ") || rep.query;

    clusters.push({
      id: `cluster-${root}`,
      label,
      queries: sortedQueries,
      totalClicks,
      totalImpressions,
      bestPosition,
      rankingUrls,
      mapping: mappingFor(queries, rankingUrls, bestPosition, totalImpressions),
      cannibalisation,
    });
  }

  return clusters.sort((a, b) => b.totalImpressions - a.totalImpressions);
}
