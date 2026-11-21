import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "@/lib/api-client";
import { currentAccessToken } from "@/lib/control-room-session";
import { isSafePlanSvg, planAspect } from "@/lib/control-room-plan";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 916 506" fill="none" stroke="currentColor"><g><rect x="1" y="1" width="9" height="9"/></g></svg>';

describe("isSafePlanSvg", () => {
  it("accepts a drawing of plain shapes", () => {
    expect(isSafePlanSvg(SVG)).toBe(true);
    expect(isSafePlanSvg(`<?xml version="1.0"?>\n<!-- plan -->\n${SVG}`)).toBe(true);
  });

  it.each([
    '<svg viewBox="0 0 1 1"><script>x()</script></svg>',
    '<svg viewBox="0 0 1 1"><rect onload="x()"/></svg>',
    '<svg viewBox="0 0 1 1"><use href="https://example.invalid/a#b"/></svg>',
    '<svg viewBox="0 0 1 1"><foreignObject/></svg>',
    '<svg viewBox="0 0 1 1"><rect style="fill:url(http://x)"/></svg>',
    '<!DOCTYPE svg><svg viewBox="0 0 1 1"/>',
    "<div>not a drawing</div>",
  ])("refuses %s", (text) => {
    expect(isSafePlanSvg(text)).toBe(false);
  });
});

describe("planAspect", () => {
  it("reads width over height from the viewBox", () => {
    expect(planAspect(SVG)).toEqual({ width: 916, height: 506 });
    expect(planAspect("<svg/>")).toBeNull();
  });
});

describe("currentAccessToken", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("reads the token the shared client sends, and leaves fetch as it was", async () => {
    const stub = vi.fn(async () => new Response(JSON.stringify({ user: {} }), { status: 200, headers: { "content-type": "application/json" } }));
    globalThis.fetch = stub as typeof fetch;
    const client = createApiClient({ baseUrl: "http://api.test" });
    client.setAccessToken("secret-token");
    expect(await currentAccessToken(client)).toBe("secret-token");
    expect(globalThis.fetch).toBe(stub);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("answers null without a session", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const client = createApiClient({ baseUrl: "http://api.test" });
    expect(await currentAccessToken(client)).toBeNull();
  });
});
