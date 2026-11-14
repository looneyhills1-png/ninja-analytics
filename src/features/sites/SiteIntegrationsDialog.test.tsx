import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SiteFormDialog } from "@/features/sites/SiteFormDialog";
import type { Site } from "@/types/database";

const invoke = vi.fn();
vi.mock("@/lib/supabase", () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

const site: Site = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "WW3supply",
  domain: "ww3supply.com",
  website_url: "https://ww3supply.com/",
  gsc_property: null,
  ga4_property_id: null,
  bing_site_url: "https://ww3supply.com/",
  is_active: true,
  created_at: "2026-11-14T00:00:00Z",
  updated_at: "2026-11-14T00:00:00Z",
};

function renderEdit(onClose = vi.fn()) {
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <SiteFormDialog mode="edit" site={site} onClose={onClose} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onClose };
}

beforeEach(() => invoke.mockReset());

describe("Edit site: discovery, tests and save", () => {
  it("discovers properties, offers them in a dropdown and prefills only empty fields", async () => {
    invoke.mockResolvedValue({
      data: {
        ok: true,
        providers: {
          gsc: { status: "ok", message: "ok" },
          ga4: {
            status: "api_disabled",
            message: "The Google API is not enabled for the Cloud project.",
          },
          bing: { status: "ok", message: "ok" },
        },
        candidates: {
          gsc: [
            {
              siteUrl: "sc-domain:ww3supply.com",
              permissionLevel: "siteOwner",
              usable: true,
            },
          ],
          ga4: [],
          bing: [{ url: "https://ww3supply.com/", verified: true }],
        },
        suggested: {
          gsc: [
            {
              siteUrl: "sc-domain:ww3supply.com",
              permissionLevel: "siteOwner",
              usable: true,
            },
          ],
          ga4: [],
          bing: [{ url: "https://ww3supply.com/", verified: true }],
        },
      },
      error: null,
    });
    renderEdit();
    fireEvent.click(
      screen.getByRole("button", { name: /discover properties/i }),
    );

    await waitFor(() =>
      expect(
        screen.getByLabelText("Google Search Console identifier"),
      ).toHaveValue("sc-domain:ww3supply.com"),
    );
    expect(invoke).toHaveBeenCalledWith("site-integrations", {
      body: { action: "discover", domain: "ww3supply.com" },
    });
    expect(
      screen.getByText(/Google API is not enabled for the Cloud project/),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Google Search Console discovered properties"),
    ).toBeInTheDocument();
  });

  it("runs a read-only connection test and shows the provider's answer", async () => {
    invoke.mockResolvedValue({
      data: {
        ok: true,
        result: {
          status: "missing_permission",
          message: "No access to this property.",
        },
      },
      error: null,
    });
    renderEdit();
    fireEvent.change(screen.getByLabelText("Google Analytics 4 identifier"), {
      target: { value: "553851848" },
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /test connection/i })[1],
    );
    expect(
      await screen.findByText("No access to this property."),
    ).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith("site-integrations", {
      body: {
        action: "test",
        provider: "ga4",
        value: "553851848",
        domain: "ww3supply.com",
      },
    });
  });

  it("asks for confirmation before replacing a property that has history", async () => {
    const err = Object.assign(new Error("x"), {
      context: {
        status: 409,
        json: async () => ({
          error: "property_change_requires_confirmation",
          message:
            "Changing a property that already has stored history mixes data.",
        }),
        clone() {
          return this;
        },
      },
    });
    invoke.mockResolvedValue({ data: null, error: err });
    renderEdit();
    fireEvent.change(screen.getByLabelText("Bing Webmaster identifier"), {
      target: { value: "https://ww3supply.com/new/" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText(/mixes data/)).toBeInTheDocument();
    expect(screen.getByText(/I understand history/)).toBeInTheDocument();
  });

  it("Save & sync saves, then syncs each enabled configured provider once", async () => {
    invoke.mockImplementation(async (fn: string) => {
      if (fn === "manage-sites") {
        return {
          data: {
            ok: true,
            site: { ...site, gsc_property: "sc-domain:ww3supply.com" },
          },
          error: null,
        };
      }
      return {
        data: {
          ok: true,
          runs: [{ source: "x", status: "success", rowsWritten: 5 }],
        },
        error: null,
      };
    });
    renderEdit();
    fireEvent.change(
      screen.getByLabelText("Google Search Console identifier"),
      {
        target: { value: "sc-domain:ww3supply.com" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: /save & sync/i }));

    expect(
      await screen.findByText(/Google Search Console: synced \(5 rows\)/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Bing Webmaster: synced/)).toBeInTheDocument();
    // GA4 has no id, so it is never synced.
    expect(screen.queryByText(/Google Analytics 4: /)).not.toBeInTheDocument();
    const syncCalls = invoke.mock.calls.filter((c) => c[0] === "manual-sync");
    expect(syncCalls).toHaveLength(2);
    const manage = invoke.mock.calls.find((c) => c[0] === "manage-sites")![1];
    expect(manage.body.integrations).toEqual({
      gsc: true,
      ga4: true,
      bing: true,
    });
  });
});
