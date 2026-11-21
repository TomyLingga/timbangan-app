// The access token for the control room's event stream.
//
// The shared API client (lib/api-client.ts) keeps the token in a closure and has no streaming call, and the stream
// has to be read with fetch and a bearer header. Until the client exposes its token, it is read from the
// Authorization header of one small request made through the client: the client calls globalThis.fetch at request
// time, so a wrapper installed for that one call sees the header (after the client's own refresh and retry, if the
// token had expired). The wrapper passes every request through unchanged and is removed when the call ends.
// Replace this with a getter on ApiClient when one exists.

import type { ApiClient } from "@/lib/api-client";

const PROBE_PATH = "/api/me";

let inFlight: Promise<string | null> | null = null;

async function capture(client: ApiClient): Promise<string | null> {
  const original = globalThis.fetch;
  let seen: string | null = null;
  const wrapper: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(PROBE_PATH)) {
      const header = new Headers(init?.headers).get("authorization");
      if (header?.startsWith("Bearer ")) seen = header.slice("Bearer ".length);
    }
    return original(input, init);
  };
  globalThis.fetch = wrapper;
  try {
    await client.request(PROBE_PATH);
    return seen;
  } catch {
    return null;
  } finally {
    // only undo our own wrapper; something installed after it stays
    if (globalThis.fetch === wrapper) globalThis.fetch = original;
  }
}

/** The client's current access token, or null without a session. `refresh` renews it first. */
export async function currentAccessToken(client: ApiClient, { refresh = false }: { refresh?: boolean } = {}): Promise<string | null> {
  if (refresh) {
    try {
      if (!(await client.refresh())) return null;
    } catch {
      return null;
    }
  }
  if (!client.hasAccessToken()) return null;
  inFlight ??= capture(client).finally(() => {
    inFlight = null;
  });
  return inFlight;
}
