import { describe, expect, it } from "vitest";
import { testApp } from "./helpers/app.js";
import { PASSWORD, seedStaff } from "./helpers/users.js";

// The phone app keeps its refresh token in the phone's secure store, so it gets the token in the body instead
// of a cookie. A phone token only works in the body and a web cookie only as a cookie.
async function phoneSignedIn(client: "android" | "ios" = "android") {
  const context = await testApp();
  await seedStaff(context.database, "operator");
  const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: PASSWORD, client } });
  return { ...context, response };
}

describe("phone sessions", () => {
  it("login with client android or ios answers the refresh token in the body, sets no cookie, and records the client", async () => {
    for (const client of ["android", "ios"] as const) {
      const { response, database } = await phoneSignedIn(client);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { accessToken: string; refreshToken: string; user: { username: string } };
      expect(typeof body.accessToken).toBe("string");
      expect(body.refreshToken).toMatch(/^[A-Za-z0-9_-]{30,}$/);
      expect(body.user.username).toBe("operator");
      expect(response.cookies.find((item) => item.name === "refresh_token")).toBeUndefined();
      expect(await database.query("select client from auth_sessions")).toEqual([{ client: client.toUpperCase() }]);
    }
  });

  it("refresh with the body token rotates it and answers the new one in the body", async () => {
    const { app, response } = await phoneSignedIn();
    const first = (response.json() as { refreshToken: string }).refreshToken;
    const rotated = await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: first } });
    expect(rotated.statusCode, rotated.body).toBe(200);
    const next = rotated.json() as { accessToken: string; refreshToken: string };
    expect(next.refreshToken).not.toBe(first);
    expect(rotated.cookies.find((item) => item.name === "refresh_token")).toBeUndefined();
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: first } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: next.refreshToken } })).statusCode).toBe(200);
  });

  it("a phone token is refused as a cookie and a web token is refused in the body", async () => {
    const { app, response } = await phoneSignedIn();
    const phoneToken = (response.json() as { refreshToken: string }).refreshToken;
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", cookies: { refresh_token: phoneToken } })).statusCode).toBe(401);

    const web = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: PASSWORD } });
    const webToken = web.cookies.find((item) => item.name === "refresh_token")?.value ?? "";
    expect(webToken).not.toBe("");
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: webToken } })).statusCode).toBe(401);
  });

  it("logout with the body token revokes the phone session", async () => {
    const { app, database, response } = await phoneSignedIn();
    const token = (response.json() as { refreshToken: string }).refreshToken;
    expect((await app.inject({ method: "POST", url: "/api/auth/logout", payload: { refreshToken: token } })).statusCode).toBe(200);
    expect(await database.query("select (revoked_at is not null) as revoked from auth_sessions")).toEqual([{ revoked: true }]);
    expect((await app.inject({ method: "POST", url: "/api/auth/refresh", payload: { refreshToken: token } })).statusCode).toBe(401);
  });

  it("refuses an unknown client value", async () => {
    const context = await testApp();
    await seedStaff(context.database, "operator");
    const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "operator", password: PASSWORD, client: "mobile" } });
    expect(response.statusCode).toBe(400);
  });
});

describe("CORS", () => {
  it("lets the web page read the file name of a CSV download", async () => {
    const context = await testApp();
    const response = await context.app.inject({ method: "GET", url: "/api/health", headers: { origin: context.config.webOrigin } });
    expect(String(response.headers["access-control-expose-headers"] ?? "").toLowerCase()).toContain("content-disposition");
  });
});
