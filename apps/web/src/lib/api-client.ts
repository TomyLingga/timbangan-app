// HTTP client for the registration API.
//
// The access token is kept in a closure, never in localStorage or a cookie the
// page can read. The refresh token is an httpOnly cookie owned by the API, so
// every call goes out with `credentials: "include"`.

export const SIGNED_OUT = "SIGNED_OUT";
export const NETWORK_ERROR = "NETWORK_ERROR";

const REFRESH_PATH = "/api/auth/refresh";

export class ApiError extends Error {
  /** HTTP status, or 0 when the request never got an answer. */
  readonly status: number;
  /** Code from the API error envelope, or a client-side code such as SIGNED_OUT. */
  readonly code: string;

  /** Names of the request fields the API refused (from `error.fields`), if it said. */
  readonly fields: string[];
  /** Field path to the API's message for it. The API writes these in Indonesian for users. */
  readonly fieldMessages: Record<string, string>;

  constructor(status: number, code: string, message: string, fields: string[] = [], fieldMessages: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.fieldMessages = fieldMessages;
  }
}

/**
 * The contract says `fields?` without fixing its shape. Both common forms are
 * read: a map of field name to message, and a list of `{ field | path }`.
 * Only the names are kept; the wording shown to users is written in this app.
 */
function readFieldNames(fields: unknown): string[] {
  if (Array.isArray(fields)) {
    return fields
      .map((entry: unknown) => {
        if (typeof entry === "string") return entry;
        if (typeof entry !== "object" || entry === null) return null;
        const { field, path, name } = entry as { field?: unknown; path?: unknown; name?: unknown };
        const found = [field, path, name].find((value) => typeof value === "string" && value);
        return typeof found === "string" ? found : null;
      })
      .filter((value): value is string => value !== null);
  }
  if (typeof fields === "object" && fields !== null) return Object.keys(fields);
  return [];
}

/** Field to message, for the entries that carry a text message. */
function readFieldMessages(fields: unknown): Record<string, string> {
  const found: Record<string, string> = {};
  if (Array.isArray(fields)) {
    for (const entry of fields) {
      if (typeof entry !== "object" || entry === null) continue;
      const { field, path, message } = entry as { field?: unknown; path?: unknown; message?: unknown };
      const name = typeof field === "string" && field ? field : typeof path === "string" && path ? path : null;
      if (name && typeof message === "string" && message) found[name] = message;
    }
  } else if (typeof fields === "object" && fields !== null) {
    for (const [name, message] of Object.entries(fields)) if (typeof message === "string" && message) found[name] = message;
  }
  return found;
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
  /**
   * Send the bearer token and recover from a 401 with one refresh and one
   * retry. Turn off for calls that are made before a session exists (login,
   * SSO exchange) and for public routes.
   */
  auth?: boolean;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Called once when a session that was in use can no longer be renewed. */
  onSignedOut?: () => void;
}

export interface ApiClient {
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>;
  /** Asks for a new access token with the refresh cookie. False means no session. */
  refresh(): Promise<boolean>;
  setAccessToken(token: string | null): void;
  hasAccessToken(): boolean;
}

function isAbort(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

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

function toApiError(status: number, body: unknown): ApiError {
  if (typeof body === "object" && body !== null && "error" in body) {
    const envelope = (body as { error: unknown }).error;
    if (typeof envelope === "object" && envelope !== null) {
      const { code, message, fields } = envelope as { code?: unknown; message?: unknown; fields?: unknown };
      if (typeof code === "string" && code) {
        return new ApiError(
          status,
          code,
          typeof message === "string" && message ? message : code,
          readFieldNames(fields),
          readFieldMessages(fields),
        );
      }
    }
  }
  return new ApiError(status, `HTTP_${status}`, `Request failed with status ${status}`);
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const { baseUrl, onSignedOut } = options;
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  let accessToken: string | null = null;
  let refreshInFlight: Promise<boolean> | null = null;

  async function send(path: string, request: RequestOptions, token: string | null): Promise<Response> {
    const headers = new Headers({ accept: "application/json" });
    const hasBody = request.body !== undefined;
    if (hasBody) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    try {
      return await doFetch(buildUrl(baseUrl, path, request.query), {
        method: request.method ?? "GET",
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
        credentials: "include",
        signal: request.signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError(0, NETWORK_ERROR, "The API could not be reached");
    }
  }

  async function runRefresh(): Promise<boolean> {
    const tokenAtStart = accessToken;
    const response = await send(REFRESH_PATH, { method: "POST" }, null);
    const body = await readBody(response);
    if (response.status === 401) {
      // A sign-in may have stored a token while this call was out; keep it.
      if (accessToken === tokenAtStart) accessToken = null;
      return false;
    }
    if (!response.ok) throw toApiError(response.status, body);
    const token = (body as { accessToken?: unknown } | undefined)?.accessToken;
    if (typeof token !== "string" || !token) {
      throw new ApiError(response.status, "BAD_RESPONSE", "The refresh answer carried no access token");
    }
    accessToken = token;
    return true;
  }

  /** Single flight: callers that arrive while a refresh is running share it. */
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

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const useAuth = requestOptions.auth !== false;
    const tokenUsed = useAuth ? accessToken : null;

    let response = await send(path, requestOptions, tokenUsed);

    if (response.status === 401 && useAuth) {
      // Another request may have renewed the token while this one was out.
      const alreadyRenewed = accessToken !== null && accessToken !== tokenUsed;
      if (!alreadyRenewed && !(await refresh())) throw signedOut();
      response = await send(path, requestOptions, accessToken);
      if (response.status === 401) throw signedOut();
    }

    const body = await readBody(response);
    if (!response.ok) throw toApiError(response.status, body);
    return body as T;
  }

  return {
    request,
    refresh,
    setAccessToken(token) {
      accessToken = token;
    },
    hasAccessToken() {
      return accessToken !== null;
    },
  };
}
