import { describe, expect, it } from "vitest";

import { readSsoTicket, ssoForwardTarget } from "@/lib/sso-ticket";

describe("readSsoTicket", () => {
  it("returns both values when the query carries them", () => {
    expect(readSsoTicket("?token=abc&appId=app-1")).toEqual({ token: "abc", appId: "app-1" });
    expect(readSsoTicket("token=abc&appId=app-1&x=1")).toEqual({ token: "abc", appId: "app-1" });
  });

  it("returns null when either value is missing or empty", () => {
    expect(readSsoTicket("")).toBeNull();
    expect(readSsoTicket("?token=abc")).toBeNull();
    expect(readSsoTicket("?appId=app-1")).toBeNull();
    expect(readSsoTicket("?token=&appId=app-1")).toBeNull();
  });
});

describe("ssoForwardTarget", () => {
  it("forwards the root route to the callback page with the same query", () => {
    expect(ssoForwardTarget("/", "?token=a%2Bb&appId=app 1")).toBe("/auth/sso?token=a%2Bb&appId=app+1");
  });

  it("drops unrelated query values", () => {
    expect(ssoForwardTarget("/", "?token=abc&appId=app-1&utm=x")).toBe("/auth/sso?token=abc&appId=app-1");
  });

  it("does nothing without a complete ticket", () => {
    expect(ssoForwardTarget("/", "")).toBeNull();
    expect(ssoForwardTarget("/", "?token=abc")).toBeNull();
  });

  it("does nothing on the callback page itself", () => {
    expect(ssoForwardTarget("/auth/sso", "?token=abc&appId=app-1")).toBeNull();
  });

  it("also forwards other signed-in routes that receive a ticket", () => {
    expect(ssoForwardTarget("/kontrak", "?token=abc&appId=app-1")).toBe("/auth/sso?token=abc&appId=app-1");
  });
});
