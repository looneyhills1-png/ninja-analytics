import { describe, expect, it } from "vitest";
import {
  expandSources,
  includesUptime,
  isUuid,
  parseManualSyncInput,
} from "../../supabase/functions/_shared/validate";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("isUuid", () => {
  it("accepts a valid v4 uuid", () => {
    expect(isUuid(UUID)).toBe(true);
  });
  it("accepts the seed-style repeated-digit uuids", () => {
    expect(isUuid("11111111-1111-1111-1111-111111111111")).toBe(true);
  });
  it("rejects junk", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("11111111-1111-1111-1111-11111111111")).toBe(false); // 11 hex
    expect(isUuid(123)).toBe(false);
  });
});

describe("parseManualSyncInput", () => {
  it("accepts a valid site + source", () => {
    const r = parseManualSyncInput({ siteId: UUID, source: "gsc" });
    expect(r.ok).toBe(true);
  });

  it("accepts the uptime source", () => {
    const r = parseManualSyncInput({ siteId: UUID, source: "uptime" });
    expect(r.ok).toBe(true);
  });

  it("rejects an invalid uuid", () => {
    const r = parseManualSyncInput({ siteId: "x", source: "gsc" });
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown source", () => {
    const r = parseManualSyncInput({ siteId: UUID, source: "yandex" });
    expect(r.ok).toBe(false);
  });

  it("requires both range bounds together", () => {
    const r = parseManualSyncInput({
      siteId: UUID,
      source: "ga4",
      rangeStart: "2026-01-01",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects a reversed range", () => {
    const r = parseManualSyncInput({
      siteId: UUID,
      source: "ga4",
      rangeStart: "2026-02-01",
      rangeEnd: "2026-01-01",
    });
    expect(r.ok).toBe(false);
  });

  it("accepts a valid range", () => {
    const r = parseManualSyncInput({
      siteId: UUID,
      source: "ga4",
      rangeStart: "2026-01-01",
      rangeEnd: "2026-01-31",
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-object body", () => {
    expect(parseManualSyncInput(null).ok).toBe(false);
    expect(parseManualSyncInput("nope").ok).toBe(false);
  });
});

describe("expandSources", () => {
  it("expands 'all' to the three sync sources", () => {
    expect(expandSources("all")).toEqual(["gsc", "ga4", "bing"]);
  });
  it("returns a single source as-is", () => {
    expect(expandSources("bing")).toEqual(["bing"]);
  });
  it("expands 'uptime' to no sync-run sources", () => {
    expect(expandSources("uptime")).toEqual([]);
  });
});

describe("includesUptime", () => {
  it("is true for 'all' and 'uptime'", () => {
    expect(includesUptime("all")).toBe(true);
    expect(includesUptime("uptime")).toBe(true);
  });
  it("is false for a single sync source", () => {
    expect(includesUptime("gsc")).toBe(false);
    expect(includesUptime("ga4")).toBe(false);
    expect(includesUptime("bing")).toBe(false);
  });
});
