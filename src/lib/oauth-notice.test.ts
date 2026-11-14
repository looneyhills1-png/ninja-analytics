import { describe, expect, it } from "vitest";
import { computeOAuthNotice } from "./oauth-notice";

const issued = "2026-11-14T13:08:11Z";
const at = (iso: string) => new Date(iso);

describe("computeOAuthNotice", () => {
  it("shows a countdown while in Testing", () => {
    const s = computeOAuthNotice(
      { publishing_status: "testing", token_issued_at: issued },
      null,
      at("2026-11-15T13:08:11Z"),
    );
    expect(s).toMatchObject({ visible: true, daysLeft: 6, urgent: false });
    expect(s.expiresAt?.toISOString()).toBe("2026-11-21T13:08:11.000Z");
  });

  it("stays hidden once dismissed, until within 48 hours of expiry", () => {
    const d = { publishing_status: "testing", token_issued_at: issued };
    expect(
      computeOAuthNotice(d, "2026-11-15T00:00:00Z", at("2026-11-16T00:00:00Z"))
        .visible,
    ).toBe(false);
    const late = computeOAuthNotice(
      d,
      "2026-11-15T00:00:00Z",
      at("2026-11-20T00:00:00Z"),
    );
    expect(late).toMatchObject({ visible: true, urgent: true });
  });

  it("clamps at zero after expiry and hides once published", () => {
    const d = { publishing_status: "testing", token_issued_at: issued };
    expect(
      computeOAuthNotice(d, null, at("2026-12-01T00:00:00Z")).daysLeft,
    ).toBe(0);
    expect(
      computeOAuthNotice({ publishing_status: "production" }, null, new Date())
        .visible,
    ).toBe(false);
  });

  it("still warns when the issue date is unknown", () => {
    expect(
      computeOAuthNotice({ publishing_status: "testing" }, null, new Date()),
    ).toMatchObject({ visible: true, daysLeft: null });
  });
});
