import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SiteOptimisationPanel } from "@/features/intelligence/SiteOptimisationPanel";
import type { OptimisationChange } from "@/types/database";

const analyseMutate = vi.fn();
const setModeMutate = vi.fn();
const actionMutate = vi.fn();
let state: {
  mode: string;
  run: unknown;
  changes: OptimisationChange[];
};

vi.mock("@/features/intelligence/CoverageSection", () => ({
  CoverageSection: () => null,
}));

vi.mock("@/features/intelligence/optimise-api", () => ({
  MAX_AUTO: 2,
  useOptimiseState: () => ({ isLoading: false, isError: false, data: state }),
  useAnalyse: () => ({
    mutate: analyseMutate,
    isPending: false,
    isError: false,
    isSuccess: false,
  }),
  useSetMode: () => ({
    mutate: setModeMutate,
    isPending: false,
    isError: false,
  }),
  useChangeAction: () => ({ mutate: actionMutate, isError: false }),
  useChangeOutcome: () => ({ data: undefined }),
}));

const change = (o: Partial<OptimisationChange>): OptimisationChange =>
  ({
    id: "c1",
    site_id: "s1",
    title: "Refresh the meta description",
    problem: "Ranks well but gets no clicks.",
    recommendation: "Lead with the query.",
    url: "https://ninjatickets.com/guides/oasis-tickets/",
    change_class: "meta_description_refresh",
    risk: "low",
    priority: 70,
    status: "proposed",
    auto_eligible: true,
    evidence: {},
    updated_at: "2026-11-14T10:00:00Z",
    commit_sha: null,
    note: null,
    ...o,
  }) as OptimisationChange;

beforeEach(() => {
  state = {
    mode: "monitor",
    run: {
      started_at: "2026-11-15T09:00:00Z",
      health: {
        score: 82,
        scoreSource: "Site audit of 100 pages",
        searchDataThrough: "2026-11-13",
        auditAt: "2026-11-10T10:00:00Z",
        stale: [],
      },
    },
    changes: [
      change({}),
      change({
        id: "c2",
        title: "Add FAQ answers",
        risk: "substantial",
        status: "needs_approval",
        auto_eligible: false,
        priority: 60,
        change_class: "content_edit",
      }),
    ],
  };
  analyseMutate.mockClear();
  setModeMutate.mockClear();
  actionMutate.mockClear();
});
afterEach(cleanup);

const renderPanel = () =>
  render(
    <SiteOptimisationPanel
      siteId="s1"
      siteName="NinjaTickets"
      siteDomain="ninjatickets.com"
    />,
  );

describe("SiteOptimisationPanel", () => {
  it("shows health, freshness, the top improvements and approval status", () => {
    renderPanel();
    expect(screen.getByText("82")).toBeTruthy();
    expect(screen.getByText(/Search data through 2026-11-13/)).toBeTruthy();
    expect(screen.getByText("Refresh the meta description")).toBeTruthy();
    expect(screen.getByText("needs your approval")).toBeTruthy();
    expect(screen.getByText(/eligible for safe auto-fix/)).toBeTruthy();
  });

  it("starts in Monitor and Analyse & Optimise runs the assessment", () => {
    renderPanel();
    expect(
      screen
        .getByRole("button", { name: "Monitor" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /Analyse & Optimise/ }));
    expect(analyseMutate).toHaveBeenCalledTimes(1);
  });

  it("cannot enable Safe auto-fix without the explicit ENABLE confirmation", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Safe auto-fix" }));
    expect(setModeMutate).not.toHaveBeenCalled();
    const turnOn = screen.getByRole("button", { name: "Turn on" });
    expect(turnOn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type ENABLE to confirm"), {
      target: { value: "enable" },
    });
    expect(turnOn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Type ENABLE to confirm"), {
      target: { value: "ENABLE" },
    });
    expect(turnOn).not.toBeDisabled();
    fireEvent.click(turnOn);
    expect(setModeMutate).toHaveBeenCalledWith("safe_auto");
  });

  it("cancelling the confirmation changes nothing", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Safe auto-fix" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(setModeMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });

  it("switching back to Monitor needs no confirmation", () => {
    state.mode = "safe_auto";
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Monitor" }));
    expect(setModeMutate).toHaveBeenCalledWith("monitor");
  });

  it("offers a Fix prompt and Dismiss for each suggestion", () => {
    renderPanel();
    fireEvent.click(screen.getAllByRole("button", { name: "Fix" })[0]);
    expect(
      screen.getByRole("dialog", { name: "Generated fix prompt" }),
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(actionMutate).toHaveBeenCalledWith({
      changeId: "c1",
      action: "dismiss",
    });
  });

  it("lists applied changes with a rollback", () => {
    state.changes = [
      change({
        status: "applied",
        commit_sha: "abcdef1234567",
        note: "Safeguards passed.",
      }),
    ];
    renderPanel();
    expect(screen.getByText(/commit abcdef1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    expect(actionMutate).toHaveBeenCalledWith({
      changeId: "c1",
      action: "rollback",
    });
  });

  it("shows the hosting platform and that Ninja Analytics cannot publish there", () => {
    render(
      <SiteOptimisationPanel
        siteId="s1"
        siteName="WW3supply"
        siteDomain="ww3supply.com"
        hostingPlatform="chatgpt_sites"
        hostingProjectId="appgprj_6adaf6cd38dc8191ab79c1f60fb79ecf"
        publishing={{ ninjaCanPublish: false, summary: "No interface." }}
      />,
    );
    expect(screen.getByText(/Hosted on ChatGPT Sites/)).toBeTruthy();
    expect(
      screen.getByText(/appgprj_6adaf6cd38dc8191ab79c1f60fb79ecf/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Ninja Analytics cannot publish here/),
    ).toBeTruthy();
  });

  it("shows BLOCKED deployment and preserves the exact proposed change", () => {
    state.changes = [
      change({
        deployment: "blocked",
        deployment_note:
          "BLOCKED: this site is hosted on ChatGPT Sites. Nothing has been deployed.",
        proposed_change: {
          summary: "Use clean links.",
          totalLinks: 1,
          pages: [
            {
              page: "https://ww3supply.com/blog/",
              links: [{ from: "x/index.html", to: "x/" }],
            },
          ],
        },
      }),
    ];
    renderPanel();
    expect(
      screen.getByText(/BLOCKED: this site is hosted on ChatGPT Sites/),
    ).toBeTruthy();
    expect(screen.getByText(/Exact proposed change/)).toBeTruthy();
    expect(screen.getByText(/x\/index.html → x\//)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy exact change" }),
    ).toBeTruthy();
  });

  it("says plainly when nothing has been applied", () => {
    renderPanel();
    expect(
      screen.getByText("No change has been applied automatically."),
    ).toBeTruthy();
  });
});
