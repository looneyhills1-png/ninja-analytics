// NEURONwriter read-only helpers. Only the documented endpoints list-projects,
// list-queries and get-query are used; /new-query (which consumes analysis
// credits) is deliberately absent. Normalisation is defensive: a field is only
// reported when the API actually returned it, and nothing is invented.

export const NEURON_BASE = "https://app.neuronwriter.com/neuron-api/0.5/writer";

export interface NeuronProject {
  neuronProjectId: string;
  name: string;
  engine: string | null;
  language: string | null;
}

export interface NeuronCompetitor {
  url: string | null;
  title: string | null;
  contentScore: number | null;
}

export interface NeuronAnalysis {
  neuronQueryId: string;
  keyword: string;
  status: string;
  source: string | null;
  createdSrc: string | null;
  updatedSrc: string | null;
  questions: string[];
  competitors: NeuronCompetitor[];
  /** Raw `terms` object as returned (recommended terms), if any. */
  terms: unknown | null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

export function normalizeProjects(raw: unknown): NeuronProject[] {
  if (!Array.isArray(raw)) return [];
  const out: NeuronProject[] = [];
  for (const p of raw) {
    const o = p as Record<string, unknown>;
    const id = str(o?.project);
    if (!id) continue;
    out.push({
      neuronProjectId: id,
      name: str(o.name) ?? id,
      engine: str(o.engine),
      language: str(o.language),
    });
  }
  return out;
}

export function normalizeQueryList(raw: unknown): Array<{
  neuronQueryId: string;
  keyword: string;
  source: string | null;
  createdSrc: string | null;
  updatedSrc: string | null;
}> {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const q of raw) {
    const o = q as Record<string, unknown>;
    const id = str(o?.query) ?? str(o?.id);
    const keyword = str(o?.keyword);
    if (!id || !keyword) continue;
    out.push({
      neuronQueryId: id,
      keyword,
      source: str(o.source),
      createdSrc: str(o.created),
      updatedSrc: str(o.updated),
    });
  }
  return out;
}

function collectQuestions(ideas: unknown): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string") {
      const s = v.trim();
      if (s) out.add(s);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const s = str(o.q) ?? str(o.question) ?? str(o.text) ?? str(o.title);
      if (s) out.add(s);
    }
  };
  if (ideas && typeof ideas === "object" && !Array.isArray(ideas)) {
    for (const group of Object.values(ideas as Record<string, unknown>)) {
      if (Array.isArray(group)) group.forEach(add);
    }
  } else if (Array.isArray(ideas)) {
    ideas.forEach(add);
  }
  return [...out].slice(0, 50);
}

/** Returns null when the analysis is not ready (status other than "ready"). */
export function normalizeAnalysis(
  listItem: {
    neuronQueryId: string;
    keyword: string;
    source: string | null;
    createdSrc: string | null;
    updatedSrc: string | null;
  },
  raw: unknown,
): NeuronAnalysis {
  const o = (raw ?? {}) as Record<string, unknown>;
  const status = str(o.status) ?? "unknown";
  const ready = status === "ready";
  const competitors: NeuronCompetitor[] = [];
  if (ready && Array.isArray(o.competitors)) {
    for (const c of o.competitors.slice(0, 30)) {
      const co = c as Record<string, unknown>;
      competitors.push({
        url: str(co?.url),
        title: str(co?.title),
        contentScore: num(co?.content_score) ?? num(co?.score),
      });
    }
  }
  return {
    ...listItem,
    status,
    questions: ready ? collectQuestions(o.ideas) : [],
    competitors,
    terms: ready && o.terms != null ? o.terms : null,
  };
}

/** Map a NEURONwriter project name (e.g. "ninjatickets.com") to a site row. */
export function matchSiteByProjectName(
  projectName: string,
  sites: Array<{ id: string; domain: string }>,
): string | null {
  const clean = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");
  const target = clean(projectName);
  return sites.find((s) => clean(s.domain) === target)?.id ?? null;
}
