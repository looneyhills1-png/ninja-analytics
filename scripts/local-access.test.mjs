import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildUpstreamHeaders,
  checkProxyRequest,
  createTokenSource,
  mintAdminToken,
} from "./local-access.mjs";

const PORT = 4173;
const good = {
  host: `127.0.0.1:${PORT}`,
  "sec-fetch-site": "same-origin",
  "x-ninja-local": "1",
};
const check = (headers, url = "/sb/rest/v1/sites?select=name") =>
  checkProxyRequest({ headers: { ...good, ...headers }, url }, PORT);

describe("mintAdminToken", () => {
  it("signs an authenticated aal2 token for the admin with a 15 minute expiry", () => {
    const token = mintAdminToken("s3cret", "admin-id", 1000);
    const [h, p, sig] = token.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "HS256",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload).toMatchObject({
      role: "authenticated",
      aud: "authenticated",
      sub: "admin-id",
      aal: "aal2",
      iat: 1000,
      exp: 1900,
    });
    expect(sig).toBe(
      createHmac("sha256", "s3cret").update(`${h}.${p}`).digest("base64url"),
    );
  });

  it("refuses to mint without a secret or admin id", () => {
    expect(() => mintAdminToken("", "a")).toThrow();
    expect(() => mintAdminToken("s", "")).toThrow();
  });
});

describe("createTokenSource", () => {
  it("reuses a token, then re-mints within a minute of expiry", () => {
    let now = 1000;
    const next = createTokenSource("s", "a", () => now);
    const first = next();
    now = 1500;
    expect(next()).toBe(first);
    now = 1850;
    expect(next()).not.toBe(first);
  });
});

describe("checkProxyRequest", () => {
  it("accepts a same-origin local request and strips the /sb prefix", () => {
    expect(check({})).toEqual({
      ok: true,
      upstreamPath: "/rest/v1/sites?select=name",
    });
    expect(check({ host: `localhost:${PORT}` }).ok).toBe(true);
    expect(check({}, "/sb/functions/v1/manual-sync").ok).toBe(true);
  });

  it.each([
    ["a foreign Host (DNS rebinding)", { host: "evil.example:4173" }],
    ["the public tunnel hostname", { host: "supabase.ninjatickets.com" }],
    ["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
    ["a same-site fetch", { "sec-fetch-site": "same-site" }],
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["a missing local header", { "x-ninja-local": undefined }],
    ["a Cloudflare request", { "cf-ray": "abc" }],
    ["a proxied request", { "x-forwarded-for": "1.2.3.4" }],
  ])("rejects %s", (_label, headers) => {
    const result = check(headers);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it.each([
    "/sb/auth/v1/token",
    "/sb/storage/v1/object/x",
    "/sb/pg/tables",
    "/sb/rest/v1/../auth/v1/user",
    "/sb//rest/v1/sites",
    "/rest/v1/sites",
  ])("does not proxy %s", (url) => {
    const result = check({}, url);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });
});

describe("buildUpstreamHeaders", () => {
  it("drops browser credentials and replaces Authorization", () => {
    const out = buildUpstreamHeaders(
      {
        host: "127.0.0.1:4173",
        cookie: "a=b",
        authorization: "Bearer anon",
        origin: "http://127.0.0.1:4173",
        "sec-fetch-site": "same-origin",
        "x-ninja-local": "1",
        apikey: "pub",
        "content-type": "application/json",
      },
      "TOKEN",
    );
    expect(out).toEqual({
      apikey: "pub",
      "content-type": "application/json",
      authorization: "Bearer TOKEN",
    });
  });
});
