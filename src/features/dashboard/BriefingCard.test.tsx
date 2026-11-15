import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BriefingCard } from "@/features/dashboard/BriefingCard";
import type { InsightsResult } from "@/lib/insights";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const delta = { current: 10, previous: 8, pct: 25 };
const data = {
  days: 30,
  health: { activeSites: 3, attention: 0 },
  kpis: {
    clicks: delta,
    impressions: delta,
    users: delta,
    sessions: delta,
  },
  sites: [],
  insights: [],
} as unknown as InsightsResult;

function stub(handler: (url: string, init?: RequestInit) => unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => handler(url, init),
    })),
  );
}

describe("BriefingCard", () => {
  it("writes a briefing with the local model and says where it came from", async () => {
    stub((url) =>
      url.endsWith("/status")
        ? { available: true, model: "qwen3.5:9b" }
        : { ok: true, text: "Clicks are up.", model: "qwen3.5:9b" },
    );
    render(<BriefingCard data={data} topActionTitles={["Fix the page"]} />);
    const button = await screen.findByRole("button", {
      name: "Write my briefing",
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByText("Clicks are up.")).toBeTruthy();
    expect(screen.getByText(/Written by qwen3.5:9b/)).toBeTruthy();
  });

  it("only talks to this PC's own endpoints", async () => {
    stub((url) =>
      url.endsWith("/status")
        ? { available: true, model: "m" }
        : { ok: true, text: "ok", model: "m" },
    );
    render(<BriefingCard data={data} />);
    const button = await screen.findByRole("button", {
      name: "Write my briefing",
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await screen.findByText("ok");
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    for (const [url] of calls) expect(String(url)).toMatch(/^\/local-ai\//);
  });

  it("stays honestly disabled, with the reason, when Ollama is unavailable", async () => {
    stub(() => ({
      available: false,
      reason: "Ollama is not running on this PC (checked 127.0.0.1:11434).",
    }));
    render(<BriefingCard data={data} />);
    expect(
      (await screen.findAllByText(/Unavailable: Ollama is not running/))[0],
    ).toBeTruthy();
    const button = screen.getByRole("button", { name: "Write my briefing" });
    expect(button).toBeDisabled();
  });

  it("shows a plain message when the daily limit is reached", async () => {
    stub((url) =>
      url.endsWith("/status")
        ? { available: true, model: "m" }
        : { ok: false, error: "daily_budget_reached" },
    );
    render(<BriefingCard data={data} />);
    const button = await screen.findByRole("button", {
      name: "Write my briefing",
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("limit for today");
  });
});
