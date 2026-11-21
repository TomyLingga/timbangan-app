import { describe, expect, it, vi } from "vitest";

import { ApiError, createApiClient } from "@/lib/api-client";

const BASE = "http://api.test";

type FetchArgs = [input: string, init: RequestInit];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorBody(code: string, message = code) {
  return { error: { code, message } };
}

/** Builds a fetch double that answers from a queue and records every call. */
function fakeFetch(...responses: Array<Response | Error | (() => Response)>) {
  const queue = [...responses];
  const mock = vi.fn(async (...args: FetchArgs) => {
    void args;
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected fetch call");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  });
  return mock;
}

function headerOf(call: FetchArgs, name: string): string | null {
  return new Headers(call[1].headers).get(name);
}

function setup(...responses: Array<Response | Error | (() => Response)>) {
  const fetchMock = fakeFetch(...responses);
  const onSignedOut = vi.fn();
  const client = createApiClient({
    baseUrl: BASE,
    fetch: fetchMock as unknown as typeof fetch,
    onSignedOut,
  });
  return { client, fetchMock, onSignedOut };
}

describe("request", () => {
  it("attaches the bearer token and always sends credentials", async () => {
    const { client, fetchMock } = setup(json(200, { ok: true }));
    client.setAccessToken("token-1");

    const data = await client.request<{ ok: boolean }>("/api/me");

    expect(data).toEqual({ ok: true });
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe(`${BASE}/api/me`);
    expect(call[1].credentials).toBe("include");
    expect(headerOf(call, "authorization")).toBe("Bearer token-1");
  });

  it("sends no authorization header when auth is off", async () => {
    const { client, fetchMock } = setup(json(200, { status: "ok" }));
    client.setAccessToken("token-1");

    await client.request("/api/health", { auth: false });

    const call = fetchMock.mock.calls[0];
    expect(headerOf(call, "authorization")).toBeNull();
    expect(call[1].credentials).toBe("include");
  });

  it("serialises a JSON body and skips empty query values", async () => {
    const { client, fetchMock } = setup(json(200, {}), json(200, {}));
    client.setAccessToken("t");

    await client.request("/api/auth/login", {
      method: "POST",
      body: { username: "a", password: "b" },
      auth: false,
    });
    await client.request("/api/contracts", {
      query: { direction: "IN", q: "", limit: 100, includeClosed: false, x: undefined, y: null },
    });

    const post = fetchMock.mock.calls[0];
    expect(post[1].method).toBe("POST");
    expect(headerOf(post, "content-type")).toBe("application/json");
    expect(post[1].body).toBe('{"username":"a","password":"b"}');

    const get = fetchMock.mock.calls[1];
    expect(get[0]).toBe(`${BASE}/api/contracts?direction=IN&limit=100&includeClosed=false`);
    expect(get[1].method).toBe("GET");
    expect(get[1].body).toBeUndefined();
  });

  it("returns undefined for an empty 204 answer", async () => {
    const { client } = setup(new Response(null, { status: 204 }));
    await expect(client.request("/api/auth/logout", { method: "POST" })).resolves.toBeUndefined();
  });

  it("tolerates a trailing slash in the base URL", async () => {
    const fetchMock = fakeFetch(json(200, {}));
    const client = createApiClient({
      baseUrl: `${BASE}/`,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.request("/api/health", { auth: false });
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/health`);
  });
});

describe("401 handling", () => {
  it("refreshes once and retries once with the new token", async () => {
    const { client, fetchMock, onSignedOut } = setup(
      json(401, errorBody("TOKEN_EXPIRED")),
      json(200, { accessToken: "token-2" }),
      json(200, { items: [1] }),
    );
    client.setAccessToken("token-1");

    const data = await client.request<{ items: number[] }>("/api/contracts");

    expect(data).toEqual({ items: [1] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [first, refresh, retry] = fetchMock.mock.calls;
    expect(headerOf(first, "authorization")).toBe("Bearer token-1");
    expect(refresh[0]).toBe(`${BASE}/api/auth/refresh`);
    expect(refresh[1].method).toBe("POST");
    expect(refresh[1].credentials).toBe("include");
    expect(headerOf(refresh, "authorization")).toBeNull();
    expect(retry[0]).toBe(`${BASE}/api/contracts`);
    expect(headerOf(retry, "authorization")).toBe("Bearer token-2");
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(client.hasAccessToken()).toBe(true);
  });

  it("gives up as signed out after a second 401", async () => {
    const { client, fetchMock, onSignedOut } = setup(
      json(401, errorBody("TOKEN_EXPIRED")),
      json(200, { accessToken: "token-2" }),
      json(401, errorBody("TOKEN_EXPIRED")),
    );
    client.setAccessToken("token-1");

    const failure = await client.request("/api/contracts").catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe("SIGNED_OUT");
    expect((failure as ApiError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(client.hasAccessToken()).toBe(false);
  });

  it("gives up as signed out when the refresh itself is refused", async () => {
    const { client, fetchMock, onSignedOut } = setup(
      json(401, errorBody("TOKEN_EXPIRED")),
      json(401, errorBody("NO_SESSION")),
    );
    client.setAccessToken("token-1");

    const failure = await client.request("/api/me").catch((e: unknown) => e);

    expect((failure as ApiError).code).toBe("SIGNED_OUT");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(client.hasAccessToken()).toBe(false);
  });

  it("keeps the session when the refresh fails for another reason", async () => {
    const { client, onSignedOut } = setup(
      json(401, errorBody("TOKEN_EXPIRED")),
      new TypeError("fetch failed"),
    );
    client.setAccessToken("token-1");

    const failure = await client.request("/api/me").catch((e: unknown) => e);

    expect((failure as ApiError).code).toBe("NETWORK_ERROR");
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(client.hasAccessToken()).toBe(true);
  });

  it("shares one refresh between requests that fail together", async () => {
    const calls: string[] = [];
    let refreshes = 0;
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      const auth = new Headers(init.headers).get("authorization");
      calls.push(`${input.replace(BASE, "")} ${auth ?? "-"}`);
      if (input.endsWith("/api/auth/refresh")) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json(200, { accessToken: "token-2" });
      }
      return auth === "Bearer token-2" ? json(200, { ok: true }) : json(401, errorBody("TOKEN_EXPIRED"));
    });
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch });
    client.setAccessToken("token-1");

    const results = await Promise.all([client.request("/api/a"), client.request("/api/b")]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(5);
  });

  it("does not refresh for calls made without auth, such as login", async () => {
    const { client, fetchMock, onSignedOut } = setup(
      json(401, errorBody("INVALID_CREDENTIALS", "Wrong username or password")),
    );

    const failure = await client
      .request("/api/auth/login", { method: "POST", body: {}, auth: false })
      .catch((e: unknown) => e);

    expect((failure as ApiError).code).toBe("INVALID_CREDENTIALS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onSignedOut).not.toHaveBeenCalled();
  });
});

describe("refresh", () => {
  it("stores the new token and reports success", async () => {
    const { client, fetchMock } = setup(json(200, { accessToken: "fresh" }), json(200, {}));

    await expect(client.refresh()).resolves.toBe(true);
    await client.request("/api/me");

    expect(headerOf(fetchMock.mock.calls[1], "authorization")).toBe("Bearer fresh");
  });

  it("reports false on 401 without raising a signed-out event", async () => {
    const { client, onSignedOut } = setup(json(401, errorBody("NO_SESSION")));

    await expect(client.refresh()).resolves.toBe(false);

    expect(client.hasAccessToken()).toBe(false);
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("keeps a token that a sign-in stored while the refresh was out", async () => {
    let answerRefresh: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      answerRefresh = resolve;
    });
    const fetchMock = vi.fn(async () => pending);
    const client = createApiClient({ baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch });

    const refreshing = client.refresh();
    client.setAccessToken("from-login");
    answerRefresh(json(401, errorBody("NO_SESSION")));

    await expect(refreshing).resolves.toBe(false);
    expect(client.hasAccessToken()).toBe(true);
  });

  it("runs once when called twice at the same time", async () => {
    const { client, fetchMock } = setup(json(200, { accessToken: "fresh" }));

    const [a, b] = await Promise.all([client.refresh(), client.refresh()]);

    expect([a, b]).toEqual([true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("errors", () => {
  it("turns the error envelope into a typed error", async () => {
    const { client } = setup(json(409, errorBody("SYNC_RUNNING", "A sync is already running")));
    client.setAccessToken("t");

    const failure = await client.request("/api/admin/sync/odoo", { method: "POST" }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toBeInstanceOf(Error);
    const error = failure as ApiError;
    expect(error.status).toBe(409);
    expect(error.code).toBe("SYNC_RUNNING");
    expect(error.message).toBe("A sync is already running");
  });

  it("keeps the names of the fields the API refused", async () => {
    const { client } = setup(
      json(400, { error: { code: "VALIDATION", message: "Invalid body", fields: { plateDisplay: "too short", roles: ["unknown role"] } } }),
      json(400, { error: { code: "VALIDATION", message: "Invalid body", fields: [{ field: "name", message: "required" }, { path: "address" }] } }),
      json(409, { error: { code: "DUPLICATE", message: "Already there" } }),
    );
    client.setAccessToken("t");

    const asMap = (await client.request("/api/vehicles", { method: "POST", body: {} }).catch((e: unknown) => e)) as ApiError;
    const asList = (await client.request("/api/destinations", { method: "POST", body: {} }).catch((e: unknown) => e)) as ApiError;
    const without = (await client.request("/api/drivers", { method: "POST", body: {} }).catch((e: unknown) => e)) as ApiError;

    expect(asMap.fields).toEqual(["plateDisplay", "roles"]);
    expect(asList.fields).toEqual(["name", "address"]);
    expect(without.fields).toEqual([]);
  });

  it("keeps the message of each refused field as the API writes it", async () => {
    const { client } = setup(
      json(400, {
        error: {
          code: "VALIDATION",
          message: "Data yang dikirim tidak valid.",
          fields: [
            { field: "allocations", message: "Semua kontrak atau DO dalam satu registrasi harus satu jalur barang." },
            { field: "trips.0.driver.licenceNo", message: "Nomor SIM wajib diisi." },
            { path: "address" },
          ],
        },
      }),
      json(400, { error: { code: "VALIDATION", message: "Invalid body", fields: { plateDisplay: "too short", roles: ["x"] } } }),
    );
    client.setAccessToken("t");

    const asList = (await client.request("/api/registrations", { method: "POST", body: {} }).catch((e: unknown) => e)) as ApiError;
    const asMap = (await client.request("/api/vehicles", { method: "POST", body: {} }).catch((e: unknown) => e)) as ApiError;

    expect(asList.fieldMessages).toEqual({
      allocations: "Semua kontrak atau DO dalam satu registrasi harus satu jalur barang.",
      "trips.0.driver.licenceNo": "Nomor SIM wajib diisi.",
    });
    expect(asMap.fieldMessages).toEqual({ plateDisplay: "too short" });
  });

  it("falls back to an HTTP code when the body is not the envelope", async () => {
    const { client } = setup(new Response("<html>Bad gateway</html>", { status: 502 }));
    client.setAccessToken("t");

    const failure = (await client.request("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(failure.status).toBe(502);
    expect(failure.code).toBe("HTTP_502");
  });

  it("reports a network failure with status 0", async () => {
    const { client } = setup(new TypeError("fetch failed"));
    client.setAccessToken("t");

    const failure = (await client.request("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(0);
    expect(failure.code).toBe("NETWORK_ERROR");
  });

  it("lets an abort pass through untouched", async () => {
    const abort = new DOMException("The operation was aborted.", "AbortError");
    const { client } = setup(abort);
    client.setAccessToken("t");

    const failure = await client.request("/api/me").catch((e: unknown) => e);

    expect(failure).toBe(abort);
  });
});
