// The weighbridge routes of the API, signed with the station key (X-Station-Key). Every call has a timeout. Calls
// that are safe to repeat (reads, the weighing with its request id, heartbeat, cancel, speech) are tried once more
// on a network error; the PIN check is not, because the API counts wrong attempts. Each call is reported to
// `onCall` with method, path, status and duration, never with the key or a PIN.
import type { ApiFailure, CancelAnswer, CardAnswer, HeartbeatAnswer, ManualPlateAnswer, WeighAnswer } from "../shared/api-types";

export type ApiResult<T> = { ok: true; status: number; body: T } | { ok: false; failure: ApiFailure };

export interface ApiCallLog {
  method: string;
  path: string;
  status: number | null;
  ms: number;
  error?: string;
}

export interface ApiClientOptions {
  baseUrl: string;
  stationKey: string;
  timeoutMs?: number;
  /** Speech can take a few seconds to synthesise on the server. */
  speechTimeoutMs?: number;
  fetch?: typeof fetch;
  onCall?: (entry: ApiCallLog) => void;
}

export interface WeighBody {
  cardUid: string;
  weightKg: number;
  plateRead: string | null;
  requestId: string;
}

export type ApiClient = ReturnType<typeof createApiClient>;

const TIMEOUT_MESSAGE = "Waktu tunggu habis.";

class Timeout extends Error {}

function failureOf(status: number, body: unknown): ApiFailure {
  const envelope = (body as { error?: Record<string, unknown> } | null)?.error;
  if (envelope && typeof envelope.code === "string") {
    const { code, message, speech, ...details } = envelope;
    return {
      kind: "api",
      status,
      code,
      message: typeof message === "string" ? message : "",
      speech: Array.isArray(speech) ? speech.filter((part): part is string => typeof part === "string") : [],
      details,
    };
  }
  return { kind: "api", status, code: `HTTP_${status}`, message: "Server menjawab dengan galat.", speech: [], details: {} };
}

export function createApiClient(options: ApiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  /** One HTTP exchange with a timeout; throws on a network error or timeout. */
  async function exchange(method: string, path: string, body: unknown, limitMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Timeout(TIMEOUT_MESSAGE)), limitMs);
    try {
      return await fetcher(`${baseUrl}${path}`, {
        method,
        headers: { "x-station-key": options.stationKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Timeout(TIMEOUT_MESSAGE);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Calls a route; retries once on a network error when `retry` is set. */
  async function call<T>(method: string, path: string, body: unknown, retry: boolean, logPath = path, limitMs = timeoutMs, read: (response: Response) => Promise<T> = (response) => response.json() as Promise<T>): Promise<ApiResult<T>> {
    const tries = retry ? 2 : 1;
    let lastError = "";
    for (let attempt = 1; attempt <= tries; attempt++) {
      const started = performance.now();
      try {
        const response = await exchange(method, path, body, limitMs);
        const ms = Math.round(performance.now() - started);
        options.onCall?.({ method, path: logPath, status: response.status, ms });
        if (response.ok) return { ok: true, status: response.status, body: await read(response) };
        const errorBody = await response.json().catch(() => null);
        return { ok: false, failure: failureOf(response.status, errorBody) };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        options.onCall?.({ method, path: logPath, status: null, ms: Math.round(performance.now() - started), error: lastError });
      }
    }
    return { ok: false, failure: { kind: "network", message: lastError } };
  }

  return {
    lookupCard: (uid: string) => call<CardAnswer>("GET", `/api/weighbridge/card/${encodeURIComponent(uid)}`, undefined, true),
    weigh: (body: WeighBody) => call<WeighAnswer>("POST", "/api/weighbridge/weigh", body, true),
    heartbeat: (id: number, weightKg: number) => call<HeartbeatAnswer>("POST", `/api/weighbridge/exceptions/${id}/heartbeat`, { weightKg }, true),
    cancel: (id: number, reason: "TRUCK_LEFT" | "OPERATOR") => call<CancelAnswer>("POST", `/api/weighbridge/exceptions/${id}/cancel`, { reason }, true),
    checkPin: (pin: string) => call<ManualPlateAnswer>("POST", "/api/weighbridge/manual-plate", { pin }, false),
    /** The WAV of one speech segment; null on 204 (no voice engine) or any failure. */
    async speechAudio(text: string): Promise<ArrayBuffer | null> {
      const path = `/api/weighbridge/speech?text=${encodeURIComponent(text)}`;
      const result = await call<ArrayBuffer | null>("GET", path, undefined, true, "/api/weighbridge/speech", options.speechTimeoutMs ?? 15_000, async (response) =>
        response.status === 204 ? null : response.arrayBuffer(),
      );
      return result.ok ? result.body : null;
    },
    /** Whether the API answers its health route. */
    async health(): Promise<boolean> {
      const result = await call<{ status?: string }>("GET", "/api/health", undefined, false, "/api/health", 5_000);
      return result.ok && result.body.status === "ok";
    },
  };
}
