import { describe, expect, it } from "vitest";
import {
  applyMetaDescriptionFix,
  assessSite,
  mayAutoApply,
  rollbackMetaDescriptionFix,
  SAFE_AUTO_ALLOWLIST,
  type AssessInput,
  type AuditIssueInput,
  type RepoClient,
} from "../../supabase/functions/_shared/optimise";

const now = new Date("2026-11-15T10:00:00Z");

const base: AssessInput = {
  site: { id: "s1", name: "NinjaTickets", domain: "ninjatickets.com" },
  mode: "monitor",
  now,
  audit: {
    finishedAt: "2026-11-10T10:00:00Z",
    pagesCrawled: 100,
    healthScore: 82,
    issues: [
      {
        url: "https://ninjatickets.com/a/",
        severity: "notice",
        code: "title_length",
        message: "Title too long",
      },
      {
        url: "https://ninjatickets.com/b/",
        severity: "notice",
        code: "title_length",
        message: "Title too long",
      },
      {
        url: null,
        severity: "notice",
        code: "crawl_budget_reached",
        message: "Stopped at 100 pages",
      },
      {
        url: "https://ninjatickets.com/c/",
        severity: "warning",
        code: "missing_meta_description",
        message: "No meta description",
      },
    ],
  },
  opportunities: [
    {
      id: "o1",
      status: "validated",
      classification: "content_improvement",
      priority: 70,
      title: "Search clicks to this page are falling",
      problem: "Clicks fell 93%",
      recommended_change: "Refresh the page",
      proposal: "original",
      target_url: "https://ninjatickets.com/oasis-tickets/",
      change_type: "edit",
      source: "gsc",
    },
    {
      id: "o2",
      status: "monitoring",
      classification: "content_improvement",
      priority: 99,
      title: "Already being monitored",
      problem: "x",
      recommended_change: null,
      proposal: "x",
      target_url: null,
      change_type: null,
      source: "gsc",
    },
  ],
  ctrCandidates: [
    {
      query: "oasis tickets",
      url: "https://ninjatickets.com/guides/oasis-tickets/",
      currentPosition: 4.2,
      impressions: 300,
      clicks: 0,
    },
  ],
  gscThrough: "2026-11-13",
};

describe("assessSite", () => {
  it("builds an evidence-backed plan and ranks it by priority", () => {
    const a = assessSite(base);
    expect(a.items.length).toBe(4);
    const pri = a.items.map((i) => i.priority);
    expect([...pri].sort((x, y) => y - x)).toEqual(pri);
    expect(a.top3).toHaveLength(3);
    for (const i of a.items) {
      expect(i.problem).toBeTruthy();
      expect(i.recommendation).toBeTruthy();
      expect(Object.keys(i.evidence).length).toBeGreaterThan(0);
    }
  });
  it("groups repeated audit findings and skips crawl notes", () => {
    const a = assessSite(base);
    const titles = a.items.find((i) => i.key === "audit:title_length");
    expect(titles?.title).toBe("2 titles that are too long or too short");
    expect(a.items.some((i) => i.key.includes("crawl_budget"))).toBe(false);
  });
  it("points at Fix-queue items without duplicating finished ones", () => {
    const a = assessSite(base);
    expect(a.items.some((i) => i.opportunityId === "o1")).toBe(true);
    expect(a.items.some((i) => i.opportunityId === "o2")).toBe(false);
  });
  it("in monitor mode nothing is proposed for automatic action", () => {
    const a = assessSite(base);
    expect(a.items.every((i) => i.status === "needs_approval")).toBe(true);
  });
  it("only the allowlisted meta refresh can ever be auto-proposed", () => {
    const a = assessSite({ ...base, mode: "safe_auto" });
    const proposed = a.items.filter((i) => i.status === "proposed");
    expect(proposed).toHaveLength(1);
    expect(proposed[0].changeClass).toBe("meta_description_refresh");
    expect(SAFE_AUTO_ALLOWLIST).toEqual(["meta_description_refresh"]);
    for (const i of a.items.filter(
      (x) => x.changeClass !== "meta_description_refresh",
    )) {
      expect(i.autoEligible).toBe(false);
      expect(i.status).toBe("needs_approval");
    }
  });
  it("never makes a site without an authorised publisher auto-eligible", () => {
    const a = assessSite({
      ...base,
      mode: "safe_auto",
      site: { id: "s2", name: "WW3", domain: "ww3supply.com" },
    });
    expect(
      a.items.every((i) => !i.autoEligible && i.status === "needs_approval"),
    ).toBe(true);
  });
  it("reports stale data honestly", () => {
    const a = assessSite({
      ...base,
      audit: null,
      gscThrough: "2026-11-01",
    });
    expect(a.health.stale.join(" ")).toContain("No site audit");
    expect(a.health.stale.join(" ")).toContain("14 days old");
    expect(a.health.score).toBeNull();
  });
});

describe("mayAutoApply", () => {
  const ok = {
    mode: "safe_auto" as const,
    changeClass: "meta_description_refresh" as const,
    autoEligible: true,
    changeStatus: "proposed",
    hasPublisher: true,
  };
  it("allows only when every condition holds", () => {
    expect(mayAutoApply(ok)).toEqual([]);
  });
  it("refuses in monitor and approval-required modes", () => {
    expect(mayAutoApply({ ...ok, mode: "monitor" }).join()).toContain(
      "monitor mode",
    );
    expect(
      mayAutoApply({ ...ok, mode: "approval_required" }).length,
    ).toBeGreaterThan(0);
  });
  it("refuses non-allowlisted classes, unsupported sites and used changes", () => {
    expect(mayAutoApply({ ...ok, changeClass: "new_page" }).join()).toContain(
      "allowlist",
    );
    expect(mayAutoApply({ ...ok, hasPublisher: false }).join()).toContain(
      "repository",
    );
    expect(mayAutoApply({ ...ok, changeStatus: "applied" }).join()).toContain(
      "not proposed",
    );
  });
});

// ---------------------------------------------------------------------------
// Isolated test environment: an in-memory repository standing in for GitHub.
// Nothing here touches a real site or network.
// ---------------------------------------------------------------------------
function fakeRepo(initial: unknown[]) {
  let content = JSON.stringify(initial, null, 2) + "\n";
  let n = 1;
  const commits: Array<{ sha: string; message: string }> = [];
  const client: RepoClient = {
    async getFile() {
      return { content, sha: `blob${n}` };
    },
    async putFile(_p, next, previousSha, message) {
      if (previousSha !== `blob${n}`) throw new Error("conflict: file changed");
      content = next;
      n += 1;
      const sha = `commit${n}`;
      commits.push({ sha, message });
      return { commitSha: sha };
    },
  };
  return {
    client,
    commits,
    read: () => content,
    edit: (c: string) => {
      content = c;
      n += 1;
    },
  };
}

const guides = [
  {
    slug: "other-guide",
    title: "Other",
    metaDescription: "Something unrelated about another event.",
  },
  {
    slug: "oasis-tickets",
    title: "Oasis tickets",
    metaDescription:
      "Find verified information about the Oasis tour dates and where to get tickets.",
    faq: [{ q: "When?", a: "Soon" }],
  },
];

const evidence = {
  query: "oasis tickets",
  url: "https://ninjatickets.com/guides/oasis-tickets/",
  currentPosition: 4.2,
  impressions: 300,
  clicks: 0,
  ctr: 0,
  categories: ["high-impression-low-ctr"],
};

describe("safe auto-fix in an isolated environment", () => {
  const run = (repo: ReturnType<typeof fakeRepo>) =>
    applyMetaDescriptionFix({
      client: repo.client,
      filePath: "src/data/guides.json",
      slug: "oasis-tickets",
      evidence,
      generatorControlled: [],
      commitMessage: "SEO Fix: test",
    });

  it("applies one bounded change, records the backup, and rolls back exactly", async () => {
    const repo = fakeRepo(guides);
    const original = repo.read();

    const res = await run(repo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // exactly one commit, one field changed, everything else byte-identical
    expect(repo.commits).toHaveLength(1);
    expect(res.applied.before.fileContent).toBe(original);
    const after = JSON.parse(repo.read());
    expect(after[1].metaDescription).toBe(res.applied.after.metaDescription);
    expect(after[1].metaDescription.toLowerCase()).toContain("oasis tickets");
    expect(after[1].metaDescription.length).toBeLessThanOrEqual(160);
    expect(after[0]).toEqual(guides[0]);
    expect(after[1].title).toBe("Oasis tickets");
    expect(after[1].faq).toEqual(guides[1].faq);
    expect(res.applied.checks.join(" ")).toContain("bounded");

    // rollback restores the file byte for byte
    const rb = await rollbackMetaDescriptionFix({
      client: repo.client,
      filePath: "src/data/guides.json",
      backupContent: res.applied.before.fileContent,
      appliedMetaDescription: res.applied.after.metaDescription,
      slug: "oasis-tickets",
      message: "Rollback",
    });
    expect(rb.ok).toBe(true);
    expect(repo.read()).toBe(original);
    expect(repo.commits).toHaveLength(2);
  });

  it("refuses when the evidence does not support a CTR change", async () => {
    const repo = fakeRepo(guides);
    const res = await applyMetaDescriptionFix({
      client: repo.client,
      filePath: "p",
      slug: "oasis-tickets",
      evidence: { ...evidence, impressions: 3 },
      generatorControlled: [],
      commitMessage: "x",
    });
    expect(res.ok).toBe(false);
    expect(repo.commits).toHaveLength(0);
  });

  it("refuses generator-controlled pages", async () => {
    const repo = fakeRepo(guides);
    const res = await applyMetaDescriptionFix({
      client: repo.client,
      filePath: "p",
      slug: "oasis-tickets",
      evidence,
      generatorControlled: [
        {
          slug: "oasis-tickets",
          fields: ["metaDescription"],
          generator: "gen.ts",
        },
      ],
      commitMessage: "x",
    });
    expect(res.ok).toBe(false);
    expect(repo.commits).toHaveLength(0);
  });

  it("refuses an unclean baseline (missing or duplicated slug, bad JSON)", async () => {
    const dup = fakeRepo([...guides, guides[1]]);
    expect((await run(dup)).ok).toBe(false);
    const missing = fakeRepo([guides[0]]);
    expect((await run(missing)).ok).toBe(false);
    const broken = fakeRepo([]);
    broken.edit("{ not json");
    const r = await run(broken);
    expect(r.ok).toBe(false);
    expect(broken.commits).toHaveLength(0);
  });

  it("refuses a change that is not tightly bounded (unexpected file formatting)", async () => {
    const repo = fakeRepo(guides);
    // single-line JSON: the rewrite would change every line of the file
    repo.edit(JSON.stringify(guides));
    const res = await run(repo);
    expect(res.ok).toBe(false);
    expect(repo.commits).toHaveLength(0);
  });

  it("rollback refuses if the file was edited again after the fix", async () => {
    const repo = fakeRepo(guides);
    const res = await run(repo);
    if (!res.ok) throw new Error("setup");
    const edited = JSON.parse(repo.read());
    edited[0].metaDescription =
      "A later, unrelated owner edit to another page.";
    repo.edit(JSON.stringify(edited, null, 2) + "\n");
    const rb = await rollbackMetaDescriptionFix({
      client: repo.client,
      filePath: "p",
      backupContent: res.applied.before.fileContent,
      appliedMetaDescription: res.applied.after.metaDescription,
      slug: "oasis-tickets",
      message: "Rollback",
    });
    expect(rb.ok).toBe(false);
    expect(JSON.parse(repo.read())[0].metaDescription).toContain("later");
  });

  it("the optimistic write refuses if the file moves during the fix", async () => {
    const repo = fakeRepo(guides);
    const racing: RepoClient = {
      getFile: repo.client.getFile,
      putFile: async (...a) => {
        repo.edit(repo.read() + " ");
        return repo.client.putFile(...a);
      },
    };
    await expect(
      applyMetaDescriptionFix({
        client: racing,
        filePath: "p",
        slug: "oasis-tickets",
        evidence,
        generatorControlled: [],
        commitMessage: "x",
      }),
    ).rejects.toThrow("conflict");
    expect(repo.commits).toHaveLength(0);
  });
});

describe("assessSite index.html aliases and hosting", () => {
  const url = (p: string) => `https://ww3supply.com${p}`;
  const alias = (p: string) => ({
    url: url(`${p}index.html`),
    severity: "notice" as const,
    code: "non_self_canonical",
    message: `Canonical points to a different URL: ${url(p)}.`,
  });
  const dup = (code: string, u: string) => ({
    url: u,
    severity: "warning" as const,
    code,
    message: code,
  });
  const ww3 = { id: "s3", name: "WW3", domain: "ww3supply.com" };
  const auditOf = (issues: AuditIssueInput[]) => ({
    finishedAt: "2026-11-15T09:00:00Z",
    pagesCrawled: 4,
    healthScore: 90,
    issues,
  });

  it("treats canonicalised /index.html aliases as one low-urgency link tidy-up", () => {
    const a = assessSite({
      ...base,
      site: ww3,
      audit: auditOf([alias("/a/"), alias("/b/")]),
      opportunities: [],
      ctrCandidates: [],
    });
    expect(a.items).toHaveLength(1);
    const it = a.items[0];
    expect(it.key).toBe("audit:index_html_aliases");
    expect(it.changeClass).toBe("internal_links");
    expect(it.priority).toBeLessThan(50);
    expect(it.problem).toContain("declare the clean address as canonical");
    expect(it.recommendation).toContain("clean addresses");
    expect(JSON.stringify(it)).not.toMatch(/htaccess|WordPress|nginx|apache/i);
  });

  it("folds legacy duplicate warnings for those pages into the same item", () => {
    const pages = ["/a/", "/a/index.html"].map(url);
    const a = assessSite({
      ...base,
      site: ww3,
      audit: auditOf([
        alias("/a/"),
        ...pages.flatMap((u) => [
          dup("duplicate_title", u),
          dup("duplicate_content", u),
        ]),
      ]),
      opportunities: [],
      ctrCandidates: [],
    });
    expect(a.items.map((i) => i.key)).toEqual(["audit:index_html_aliases"]);
  });

  it("keeps genuine duplicate titles as a metadata finding", () => {
    const a = assessSite({
      ...base,
      audit: auditOf([
        dup("duplicate_title", url("/x/")),
        dup("duplicate_title", url("/y/")),
      ]),
      opportunities: [],
      ctrCandidates: [],
    });
    expect(a.items[0].changeClass).toBe("metadata_fix");
  });

  it("marks every change BLOCKED for a ChatGPT Sites site, never auto-eligible", () => {
    const a = assessSite({
      ...base,
      mode: "safe_auto",
      site: ww3,
      hosting: {
        platform: "chatgpt_sites",
        projectId: "appgprj_6adaf6cd38dc8191ab79c1f60fb79ecf",
      },
      audit: auditOf([alias("/a/")]),
      opportunities: [],
      ctrCandidates: [],
    });
    for (const i of a.items) {
      expect(i.deployment).toBe("blocked");
      expect(i.autoEligible).toBe(false);
      expect(i.deploymentNote).toContain("ChatGPT Sites");
      expect(i.deploymentNote).toContain(
        "appgprj_6adaf6cd38dc8191ab79c1f60fb79ecf",
      );
      expect(i.deploymentNote).toContain("Nothing has been deployed");
    }
  });

  it("does not mark advice blocked when the platform is not ChatGPT Sites", () => {
    const a = assessSite({ ...base, hosting: { platform: "github_repo" } });
    expect(a.items.every((i) => i.deployment === "not_applicable")).toBe(true);
  });
});
