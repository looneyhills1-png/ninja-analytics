import { describe, expect, it } from "vitest";
import {
  changedExistingProperties,
  findDuplicateAssignment,
  parseBingSites,
  parseGa4AccountSummaries,
  parseGscSites,
  resolveEnabled,
  suggestForDomain,
  validateGa4PropertyId,
  validateGscProperty,
  validateIntegrations,
} from "../../supabase/functions/_shared/site-integrations";

const none = { gsc_property: null, ga4_property_id: null, bing_site_url: null };

describe("identifier validation", () => {
  it("accepts domain and URL-prefix GSC properties for the site's own host", () => {
    expect(
      validateGscProperty("sc-domain:ww3supply.com", "ww3supply.com"),
    ).toEqual({
      ok: true,
      kind: "domain",
    });
    expect(
      validateGscProperty("https://www.ww3supply.com/", "ww3supply.com"),
    ).toEqual({ ok: true, kind: "url-prefix" });
  });

  it("rejects another site's property (cross-site assignment) and junk", () => {
    expect(
      validateGscProperty("sc-domain:ninjatickets.com", "ww3supply.com").ok,
    ).toBe(false);
    expect(
      validateGscProperty("https://ninjatickets.com/", "ww3supply.com").ok,
    ).toBe(false);
    expect(validateGscProperty("ww3supply.com", "ww3supply.com").ok).toBe(
      false,
    );
    expect(validateGscProperty("javascript:alert(1)", "ww3supply.com").ok).toBe(
      false,
    );
  });

  it("requires a numeric GA4 property ID, not a G- measurement ID", () => {
    expect(validateGa4PropertyId("553851848").ok).toBe(true);
    expect(validateGa4PropertyId("G-ABC123XYZ").ok).toBe(false);
    expect(validateGa4PropertyId("12ab").ok).toBe(false);
  });

  it("validates a whole integration set and names the failing field", () => {
    const r = validateIntegrations(
      { ...none, bing_site_url: "https://other.com/" },
      "ww3supply.com",
    );
    expect(r).toMatchObject({ ok: false, field: "bing_site_url" });
    expect(validateIntegrations(none, "ww3supply.com")).toEqual({ ok: true });
  });
});

describe("duplicate and change guards", () => {
  const others = [
    {
      id: "1",
      name: "NinjaTickets",
      gsc_property: "sc-domain:ninjatickets.com",
      ga4_property_id: "553851848",
      bing_site_url: "https://ninjatickets.com/",
    },
  ];

  it("blocks an identifier already used by another site", () => {
    expect(
      findDuplicateAssignment(
        { ...none, ga4_property_id: "553851848" },
        others,
      ),
    ).toEqual({ provider: "ga4", siteName: "NinjaTickets" });
    expect(
      findDuplicateAssignment(
        { ...none, bing_site_url: "https://NinjaTickets.com" },
        others,
      ),
    ).toEqual({ provider: "bing", siteName: "NinjaTickets" });
    expect(
      findDuplicateAssignment({ ...none, ga4_property_id: "111111" }, others),
    ).toBeNull();
  });

  it("flags only replacements of an existing non-empty property", () => {
    const cur = {
      gsc_property: "sc-domain:a.com",
      ga4_property_id: "1",
      bing_site_url: null,
    };
    expect(
      changedExistingProperties(cur, { ...cur, ga4_property_id: "2" }),
    ).toEqual(["ga4"]);
    expect(
      changedExistingProperties(none, { ...none, ga4_property_id: "2" }),
    ).toEqual([]);
    expect(changedExistingProperties(cur, cur)).toEqual([]);
    expect(
      changedExistingProperties(cur, { ...cur, ga4_property_id: null }),
    ).toEqual([]);
  });

  it("enables an integration only when an id exists and it is not switched off", () => {
    const ids = {
      gsc_property: "sc-domain:a.com",
      ga4_property_id: "1",
      bing_site_url: null,
    };
    expect(resolveEnabled(ids, undefined)).toEqual({
      gsc: true,
      ga4: true,
      bing: false,
    });
    expect(resolveEnabled(ids, { gsc: false, bing: true })).toEqual({
      gsc: false,
      ga4: true,
      bing: false,
    });
  });
});

describe("discovery parsing", () => {
  it("parses GSC sites with permission level", () => {
    expect(
      parseGscSites({
        siteEntry: [
          { siteUrl: "sc-domain:a.com", permissionLevel: "siteOwner" },
          { siteUrl: "https://b.com/", permissionLevel: "siteUnverifiedUser" },
          { permissionLevel: "x" },
        ],
      }),
    ).toEqual([
      {
        siteUrl: "sc-domain:a.com",
        permissionLevel: "siteOwner",
        usable: true,
      },
      {
        siteUrl: "https://b.com/",
        permissionLevel: "siteUnverifiedUser",
        usable: false,
      },
    ]);
    expect(parseGscSites({})).toEqual([]);
  });

  it("parses GA4 account summaries into numeric property ids", () => {
    expect(
      parseGa4AccountSummaries({
        accountSummaries: [
          {
            displayName: "Ninjovate",
            propertySummaries: [
              { property: "properties/553851848", displayName: "NinjaTickets" },
              { property: "weird", displayName: "x" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        propertyId: "553851848",
        displayName: "NinjaTickets",
        account: "Ninjovate",
      },
    ]);
  });

  it("parses Bing sites and suggests only candidates tied to the domain", () => {
    const bing = parseBingSites([
      { Url: "https://ww3supply.com/", IsVerified: true },
      { Url: "https://ninjatickets.com/" },
    ]);
    const s = suggestForDomain(
      "ww3supply.com",
      parseGscSites({
        siteEntry: [
          { siteUrl: "sc-domain:ww3supply.com", permissionLevel: "siteOwner" },
          {
            siteUrl: "sc-domain:ninjatickets.com",
            permissionLevel: "siteOwner",
          },
        ],
      }),
      [
        { propertyId: "1", displayName: "WW3 Supply", account: "" },
        { propertyId: "2", displayName: "NinjaTickets", account: "" },
      ],
      bing,
    );
    expect(s.gsc.map((g) => g.siteUrl)).toEqual(["sc-domain:ww3supply.com"]);
    expect(s.bing.map((b) => b.url)).toEqual(["https://ww3supply.com/"]);
    expect(s.ga4.map((p) => p.propertyId)).toEqual(["1"]);
  });
});
