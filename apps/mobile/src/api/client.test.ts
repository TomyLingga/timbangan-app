import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, isRetryable, type TokenStore } from "./client";

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function memoryTokens(initial: string | null = null): TokenStore & { value: string | null } {
  const store = {
    value: initial,
    load: async () => store.value,
    save: async (token: string) => {
      store.value = token;
    },
    clear: async () => {
      store.value = null;
    },
  };
  return store;
}

function setup(handler: Handler, tokens = memoryTokens(), extra: { timeoutMs?: number; onSignedOut?: () => void } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  const client = createApiClient({ baseUrl: "http://api.test/", fetch: fetchFn as unknown as typeof fetch, tokens, ...extra });
  return { client, calls, tokens };
}

const bodyOf = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;
const authOf = (init: RequestInit) => new Headers(init.headers).get("authorization");

describe("login", () => {
  it("sends client mobile, keeps the access token and stores the refresh token", async () => {
    const { client, calls, tokens } = setup((url) =>
      url.endsWith("/api/auth/login") ? json(200, { accessToken: "a1", refreshToken: "r1", user: { id: 1 } }) : json(200, { ok: true }),
    );
    const answer = await client.login("operator", "rahasia");
    expect(answer.user).toEqual({ id: 1 });
    expect(bodyOf(calls[0]!.init)).toEqual({ username: "operator", password: "rahasia", client: "mobile" });
    expect(tokens.value).toBe("r1");
    await client.request("/api/me");
    expect(authOf(calls[1]!.init)).toBe("Bearer a1");
  });

  it("turns the error envelope into an ApiError with field messages", async () => {
    const { client } = setup(() =>
      json(400, { error: { code: "VALIDATION", message: "Data yang dikirim tidak valid.", fields: [{ field: "username", message: "Username wajib diisi." }] } }),
    );
    const error = await client.login("", "x").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("VALIDATION");
    expect((error as ApiError).fieldMessages).toEqual({ username: "Username wajib diisi." });
  });
});

describe("silent refresh", () => {
  it("refreshes once on 401, rotates the stored token, and retries", async () => {
    let meCalls = 0;
    const { client, calls, tokens } = setup((url, init) => {
      if (url.endsWith("/api/auth/refresh")) {
        expect(bodyOf(init)).toEqual({ refreshToken: "r1", client: "mobile" });
        return json(200, { accessToken: "a2", refreshToken: "r2" });
      }
      meCalls += 1;
      return authOf(init) === "Bearer a2" ? json(200, { user: { id: 1 } }) : json(401, { error: { code: "UNAUTHORIZED", message: "x" } });
    }, memoryTokens("r1"));
    client.setAccessToken("expired");
    await expect(client.request("/api/me")).resolves.toEqual({ user: { id: 1 } });
    expect(meCalls).toBe(2);
    expect(tokens.value).toBe("r2");
    expect(calls.filter((call) => call.url.endsWith("/refresh"))).toHaveLength(1);
  });

  it("refreshes before the first call when only a stored refresh token exists", async () => {
    const { client, calls } = setup((url, init) =>
      url.endsWith("/refresh") ? json(200, { accessToken: "a9", refreshToken: "r9" }) : json(200, { auth: authOf(init) }),
    memoryTokens("r1"));
    await expect(client.request("/api/work/steps")).resolves.toEqual({ auth: "Bearer a9" });
    expect(calls.map((call) => call.url)).toEqual(["http://api.test/api/auth/refresh", "http://api.test/api/work/steps"]);
  });

  it("shares one refresh between parallel calls", async () => {
    let refreshes = 0;
    const { client } = setup(async (url, init) => {
      if (url.endsWith("/refresh")) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json(200, { accessToken: "a2", refreshToken: "r2" });
      }
      return authOf(init) === "Bearer a2" ? json(200, {}) : json(401, { error: { code: "UNAUTHORIZED", message: "x" } });
    }, memoryTokens("r1"));
    client.setAccessToken("old");
    await Promise.all([client.request("/a"), client.request("/b"), client.request("/c")]);
    expect(refreshes).toBe(1);
  });

  it("signs out when the refresh token is refused", async () => {
    const onSignedOut = vi.fn();
    const { client, tokens } = setup(
      () => json(401, { error: { code: "INVALID_SESSION", message: "x" } }),
      memoryTokens("r1"),
      { onSignedOut },
    );
    client.setAccessToken("old");
    const error = (await client.request("/api/me").catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe("SIGNED_OUT");
    expect(tokens.value).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("keeps the refresh token when the refresh cannot reach the server", async () => {
    const { client, tokens } = setup(() => {
      throw new TypeError("Failed to fetch");
    }, memoryTokens("r1"));
    const error = (await client.request("/api/me").catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe("NETWORK_ERROR");
    expect(tokens.value).toBe("r1");
  });
});

describe("network and timeout", () => {
  it("gives NETWORK_ERROR with status 0 when fetch throws", async () => {
    const { client } = setup(() => {
      throw new TypeError("Network request failed");
    });
    const error = (await client.request("/x", { auth: false }).catch((caught: unknown) => caught)) as ApiError;
    expect(error.status).toBe(0);
    expect(error.code).toBe("NETWORK_ERROR");
    expect(isRetryable(error)).toBe(true);
  });

  it("aborts a call that takes longer than the timeout", async () => {
    const { client } = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
      memoryTokens(),
      { timeoutMs: 20 },
    );
    const error = (await client.request("/slow", { auth: false }).catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe("TIMEOUT");
    expect(isRetryable(error)).toBe(true);
  });

  it("adds the query string and leaves out empty values", async () => {
    const { client, calls } = setup(() => json(200, { items: [] }));
    await client.request("/api/work/steps", { auth: false, query: { module: "qc", q: "", limit: 50 } });
    expect(calls[0]!.url).toBe("http://api.test/api/work/steps?module=qc&limit=50");
  });
});

describe("isRetryable", () => {
  it("retries 5xx, 408 and 429, not other 4xx", () => {
    expect(isRetryable(new ApiError(503, "X", "x"))).toBe(true);
    expect(isRetryable(new ApiError(429, "X", "x"))).toBe(true);
    expect(isRetryable(new ApiError(408, "X", "x"))).toBe(true);
    expect(isRetryable(new ApiError(409, "NOT_READY", "x"))).toBe(false);
    expect(isRetryable(new ApiError(400, "VALIDATION", "x"))).toBe(false);
    expect(isRetryable(new Error("x"))).toBe(false);
  });
});

describe("logout", () => {
  it("sends the refresh token in the body and clears it even when the server is unreachable", async () => {
    const { client, tokens, calls } = setup(() => {
      throw new TypeError("offline");
    }, memoryTokens("r1"));
    await client.logout();
    expect(bodyOf(calls[0]!.init)).toEqual({ refreshToken: "r1", client: "mobile" });
    expect(tokens.value).toBeNull();
    expect(client.hasAccessToken()).toBe(false);
  });
});
