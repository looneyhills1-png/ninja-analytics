// Minimal GitHub REST API client for the Fix workflow's execution step
// (PART 1, 2026-09-24 brief) - reads/writes one file via the Contents API
// (guides.json is 161KB, well inside the Contents API's single-file limit)
// and polls the resulting Actions run so "commit succeeded" is never
// confused with "deploy succeeded" (the brief: "do not mark the Fix
// complete merely because the Git commit succeeded").
//
// Auth: a GitHub PAT with repo write access to looneyhills1-png/ninjatickets,
// stored as the GITHUB_PAT Supabase Edge Function secret. This is a genuine
// manual step - minting a PAT is a GitHub-account action nothing in this
// codebase can perform on the user's behalf - see the Fix Workflow report
// for exactly what to create and where to paste it.
import { SyncError, codeForStatus, isRetryableStatus } from "./errors.ts";
import { fetchWithRetry } from "./http.ts";

const API_BASE = "https://api.github.com";

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "ninja-analytics-fix-workflow",
  };
}

export function getGithubPat(): string {
  const token = Deno.env.get("GITHUB_PAT");
  if (!token) {
    throw new SyncError(
      "config_missing",
      "Missing GITHUB_PAT Supabase Edge Function secret - required for the Fix workflow to commit to ninjatickets. This must be created manually (a GitHub Personal Access Token with repo write access to looneyhills1-png/ninjatickets) - no code path can generate one.",
    );
  }
  return token;
}

async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetchWithRetry(
    `${API_BASE}${path}`,
    {
      method,
      headers: {
        ...authHeaders(token),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    },
    { timeoutMs: 20_000, maxRetries: 2 },
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body, fall through with json=null
  }
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "message" in (json as object)
        ? String((json as { message?: unknown }).message)
        : `HTTP ${res.status}`;
    throw new SyncError(
      codeForStatus(res.status),
      `GitHub API ${method} ${path}: ${message}`,
      {
        status: res.status,
        retryable: isRetryableStatus(res.status),
      },
    );
  }
  return { status: res.status, json };
}

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

export interface GetFileResult {
  content: string; // decoded UTF-8 text
  sha: string;
}

/** GET /repos/{owner}/{repo}/contents/{path} - decodes the base64 content
 * for the caller, since every consumer here needs the real text (JSON files)
 * to parse and edit, never the raw base64. */
export async function getFile(
  token: string,
  ref: RepoRef,
  filePath: string,
): Promise<GetFileResult> {
  const { json } = await githubRequest(
    token,
    "GET",
    `/repos/${ref.owner}/${ref.repo}/contents/${filePath}?ref=${encodeURIComponent(ref.branch)}`,
  );
  const data = json as { content?: string; encoding?: string; sha?: string };
  if (!data.content || data.encoding !== "base64" || !data.sha) {
    throw new SyncError(
      "provider_error",
      `GitHub Contents API returned an unexpected shape for ${filePath}`,
    );
  }
  const content = new TextDecoder().decode(
    Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) =>
      c.charCodeAt(0),
    ),
  );
  return { content, sha: data.sha };
}

export interface PutFileResult {
  commitSha: string;
  commitUrl: string;
}

/** PUT /repos/{owner}/{repo}/contents/{path} - a single-file commit directly
 * to the target branch. Requires the file's current sha (from getFile) so
 * GitHub rejects the write if the file changed underneath us since it was
 * read (optimistic concurrency - never a blind overwrite). */
export async function putFile(
  token: string,
  ref: RepoRef,
  filePath: string,
  newContent: string,
  previousSha: string,
  commitMessage: string,
): Promise<PutFileResult> {
  const contentB64 = btoa(
    Array.from(new TextEncoder().encode(newContent))
      .map((b) => String.fromCharCode(b))
      .join(""),
  );
  const { json } = await githubRequest(
    token,
    "PUT",
    `/repos/${ref.owner}/${ref.repo}/contents/${filePath}`,
    {
      message: commitMessage,
      content: contentB64,
      sha: previousSha,
      branch: ref.branch,
    },
  );
  const data = json as { commit?: { sha?: string; html_url?: string } };
  if (!data.commit?.sha) {
    throw new SyncError(
      "provider_error",
      `GitHub Contents API PUT for ${filePath} did not return a commit sha`,
    );
  }
  return {
    commitSha: data.commit.sha,
    commitUrl: data.commit.html_url ?? "",
  };
}

export interface WorkflowRunStatus {
  id: number;
  status: string; // queued/in_progress/completed
  conclusion: string | null; // success/failure/...
  htmlUrl: string;
}

/** Finds the workflow run GitHub Actions created for a given commit sha, if
 * any has appeared yet. Returns null (not an error) if none is found - the
 * caller treats that as "not started yet, check again next tick", never as
 * a failure. */
export async function findWorkflowRunForCommit(
  token: string,
  ref: RepoRef,
  workflowFile: string,
  commitSha: string,
): Promise<WorkflowRunStatus | null> {
  const { json } = await githubRequest(
    token,
    "GET",
    `/repos/${ref.owner}/${ref.repo}/actions/workflows/${workflowFile}/runs?head_sha=${commitSha}&per_page=5`,
  );
  const runs = (json as { workflow_runs?: unknown[] })?.workflow_runs ?? [];
  const run = runs[0] as
    | {
        id: number;
        status: string;
        conclusion: string | null;
        html_url: string;
      }
    | undefined;
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
  };
}

export interface GeneratorControlledManifest {
  guides: { slug: string; fields: string[]; generator: string }[];
}

/** Fetches ninjatickets' own real declaration of which guide fields are
 * generator-controlled - the "identify the actual source-of-truth
 * generator/file" requirement, read from the site's own build output
 * (public/assets/data/generator-controlled-fields.json) rather than
 * hardcoded here, so it never drifts from what build.js actually declares. */
export async function fetchGeneratorControlledManifest(
  domain: string,
): Promise<GeneratorControlledManifest> {
  try {
    const res = await fetchWithRetry(
      `https://${domain}/assets/data/generator-controlled-fields.json`,
      { headers: { Accept: "application/json" } },
      { timeoutMs: 10_000, maxRetries: 1 },
    );
    if (!res.ok) return { guides: [] };
    const data = (await res.json()) as GeneratorControlledManifest;
    return { guides: Array.isArray(data.guides) ? data.guides : [] };
  } catch {
    return { guides: [] };
  }
}
