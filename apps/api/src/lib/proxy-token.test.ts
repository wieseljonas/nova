import { afterEach, describe, expect, it, vi } from "vitest";
import { mintProxyToken, verifyProxyToken } from "./proxy-token.js";

describe("proxy-token", () => {
  const originalSecret = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = originalSecret;
    vi.restoreAllMocks();
  });

  it("mints and verifies a proxy token", () => {
    process.env.CRON_SECRET = "test-secret";

    const token = mintProxyToken({
      credentialKeys: ["close_fr", "hubspot"],
      userId: "U123",
      ttlMinutes: 15,
    });

    expect(verifyProxyToken(token)).toEqual({
      credentialKeys: ["close_fr", "hubspot"],
      userId: "U123",
    });
  });

  it("rejects a tampered proxy token", () => {
    process.env.CRON_SECRET = "test-secret";

    const token = mintProxyToken({
      credentialKeys: ["close_fr"],
      userId: "U123",
    });

    const [header, , signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        sub: "U123",
        creds: ["stripe"],
        iat: 1,
        exp: 9999999999,
      }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    expect(() => verifyProxyToken(`${header}.${tamperedPayload}.${signature}`)).toThrow(
      "Invalid proxy token signature",
    );
  });

  it("rejects an expired proxy token", () => {
    process.env.CRON_SECRET = "test-secret";
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-17T00:00:00Z").valueOf());

    const token = mintProxyToken({
      credentialKeys: ["close_fr"],
      userId: "U123",
      ttlMinutes: 1,
    });

    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-03-17T00:02:00Z").valueOf());

    expect(() => verifyProxyToken(token)).toThrow("Proxy token expired");
  });
});
