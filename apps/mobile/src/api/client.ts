// HTTP client for the API, as the phone uses it: bearer access token kept in memory, refresh token in a
// TokenStore (expo-secure-store on the phone), silent refresh with rotation, a timeout on every call, and the
// API's error envelope turned into ApiError. No React Native imports, so it runs under Vitest.

import type { LoginResponse, RefreshResponse } from "./types";

export const SIGNED_OUT = "SIGNED_OUT";
export const NETWORK_ERROR = "NETWORK_ERROR";
export const TIMEOUT = "TIMEOUT";

const LOGIN_PATH = "/api/auth/login";
const REFRESH_PATH = "/api/auth/refresh";
const LOGOUT_PATH = "/api/auth/logout";

export class ApiError extends Error {
  /** HTTP status, or 0 when no answer came (network failure or timeout). */
  readonly status: number;
  /** Code of the API envelope, or a client code: SIGNED_OUT, NETWORK_ERROR, TIMEOUT, HTTP_<status>. */
  readonly code: string;
  /** Field path to the API's message for it (the API writes them in Indonesian). */
  readonly fieldMessages: Record<string, string>;

  constructor(status: number, code: string, message: string, fieldMessages: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fieldMessages = fieldMessages;
  }
}

export const isApiError = (value: unknown): value is ApiError => value instanceof ApiError;

/** Worth sending again later: no answer, a server failure, or the server asking to wait. */
export function isRetryable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return error.status === 0 || error.status >= 500 || error.status === 408 || error.status === 429;
}

/** Where the refresh token lives between app starts. */
export interface TokenStore {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON body, or a FormData for an upload. */
  body?: unknown;
  query?: Record<string, QueryValue>;
  /** Send the bearer token and recover from a 401 with one refresh. Default true. */
  auth?: boolean;
  timeoutMs?: number;
}

export interface ApiClientOptions {
  baseUrl: string;
  tokens: TokenStore;
  fetch?: typeof fetch;
  /** Default timeout of a call in milliseconds. */
  timeoutMs?: number;
  /** Called once when a session that was in use can no longer be renewed. */
  onSignedOut?: () => void;
}

export interface ApiClient {
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  login(username: string, password: string): Promise<LoginResponse>;
  logout(): Promise<void>;
  /** Asks for a new access token with the stored refresh token. False: no session (token missing or refused). */
  refresh(): Promise<boolean>;
  setAccessToken(token: string | null): void;
  hasAccessToken(): boolean;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${url}?${search}` : url;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function fieldMessagesOf(fields: unknown): Record<string, string> {
  const found: Record<string, string> = {};
  if (!Array.isArray(fields)) return found;
  for (const entry of fields) {
    if (typeof entry !== "object" || entry === null) continue;
    const { field, message } = entry as { field?: unknown; message?: unknown };
    if (typeof field === "string" && typeof message === "string" && message) found[field] = message;
  }
  return found;
}

/** The API's `{ error: { code, message, fields } }`, or a generic HTTP_<status> error. */
export function toApiError(status: number, body: unknown): ApiError {
  if (typeof body === "object" && body !== null && "error" in body) {
    const envelope = (body as { error: unknown }).error;
    if (typeof envelope === "object" && envelope !== null) {
      const { code, message, fields } = envelope as { code?: unknown; message?: unknown; fields?: unknown };
      if (typeof code === "string" && code) {
        return new ApiError(status, code, typeof message === "string" && message ? message : code, fieldMessagesOf(fields));
      }
    }
  }
  return new ApiError(status, `HTTP_${status}`, `Request failed with status ${status}`);
}

const isAbort = (error: unknown) => typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, tokens, onSignedOut } = options;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let accessToken: string | null = null;
  let refreshInFlight: Promise<boolean> | null = null;

  async function send(path: string, request: RequestOptions, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    const isForm = typeof FormData !== "undefined" && request.body instanceof FormData;
    const hasBody = request.body !== undefined;
    if (hasBody && !isForm) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs ?? defaultTimeout);
    try {
      return await doFetch(buildUrl(baseUrl, path, request.query), {
        method: request.method ?? (hasBody ? "POST" : "GET"),
        headers,
        body: !hasBody ? undefined : isForm ? (request.body as FormData) : JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut || isAbort(error)) throw new ApiError(0, TIMEOUT, "The API did not answer in time");
      throw new ApiError(0, NETWORK_ERROR, "The API could not be reached");
    } finally {
      clearTimeout(timer);
    }
  }

  async function runRefresh(): Promise<boolean> {
    const stored = await tokens.load();
    if (!stored) return false;
    const tokenAtStart = accessToken;
    const response = await send(REFRESH_PATH, { method: "POST", body: { refreshToken: stored, client: "mobile" } }, null);
    const body = await readBody(response);
    if (response.status === 401) {
      // a sign-in may have stored a new session while this call was out; keep it
      if ((await tokens.load()) === stored) await tokens.clear();
      if (accessToken === tokenAtStart) accessToken = null;
      return false;
    }
    if (!response.ok) throw toApiError(response.status, body);
    const answer = body as Partial<RefreshResponse> | undefined;
    if (!answer?.accessToken || !answer.refreshToken) throw new ApiError(response.status, "BAD_RESPONSE", "The refresh answer carried no tokens");
    await tokens.save(answer.refreshToken);
    accessToken = answer.accessToken;
    return true;
  }

  /** Single flight: callers arriving while a refresh runs share it (a refresh token works once). */
  function refresh(): Promise<boolean> {
    refreshInFlight ??= runRefresh().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  function signedOut(): ApiError {
    accessToken = null;
    onSignedOut?.();
    return new ApiError(401, SIGNED_OUT, "The session has ended");
  }

  async function authorized(path: string, request: RequestOptions): Promise<Response> {
    if (request.auth === false) return send(path, request, null);
    if (accessToken === null && !(await refresh())) throw signedOut();
    const tokenUsed = accessToken;
    let response = await send(path, request, tokenUsed);
    if (response.status === 401) {
      const renewedMeanwhile = accessToken !== null && accessToken !== tokenUsed;
      if (!renewedMeanwhile && !(await refresh())) throw signedOut();
      response = await send(path, request, accessToken);
      if (response.status === 401) throw signedOut();
    }
    return response;
  }

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const response = await authorized(path, requestOptions);
    const body = await readBody(response);
    if (!response.ok) throw toApiError(response.status, body);
    return body as T;
  }

  async function login(username: string, password: string): Promise<LoginResponse> {
    const answer = await request<LoginResponse>(LOGIN_PATH, { method: "POST", auth: false, body: { username, password, client: "mobile" } });
    if (!answer?.accessToken || !answer.refreshToken) throw new ApiError(200, "BAD_RESPONSE", "The login answer carried no tokens");
    await tokens.save(answer.refreshToken);
    accessToken = answer.accessToken;
    return answer;
  }

  async function logout(): Promise<void> {
    const stored = await tokens.load();
    accessToken = null;
    await tokens.clear();
    if (!stored) return;
    // best effort: the session also ends on the server when the token expires
    await send(LOGOUT_PATH, { method: "POST", body: { refreshToken: stored, client: "mobile" }, timeoutMs: 5_000 }, null).catch(() => undefined);
  }

  return {
    request,
    login,
    logout,
    refresh,
    setAccessToken(token) {
      accessToken = token;
    },
    hasAccessToken() {
      return accessToken !== null;
    },
  };
}
