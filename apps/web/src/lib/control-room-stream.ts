// The live feed of the control room. GET /api/control-room/stream answers server-sent events; it is read with fetch
// because EventSource cannot send the bearer header. A dropped stream is opened again after a growing wait. After a
// few failures in a row the state is also polled every few seconds while the stream keeps being retried.

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits a text/event-stream into events as chunks arrive. Comments and fields other than event and data are skipped. */
export class SseParser {
  private buffer = "";

  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const events: SseEvent[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        else if (field === "data") data.push(value);
      }
      if (data.length) events.push({ event, data: data.join("\n") });
    }
    return events;
  }
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

/** Wait before attempt `attempt` (0 for the first retry): doubling up to 30 s, with up to half taken off at random. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const full = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(full / 2 + (random() * full) / 2);
}

export type FeedStatus = "connecting" | "live" | "reconnecting" | "polling" | "stopped";

export interface LiveFeedOptions<T> {
  streamUrl: string;
  /** The access token; `refresh` asks for a new one after a 401. Null means no session. */
  getToken: (options?: { refresh?: boolean }) => Promise<string | null>;
  /** GET /api/control-room/state, for the polling fallback. */
  poll: () => Promise<T>;
  onState: (state: T) => void;
  onStatus: (status: FeedStatus) => void;
  onStop?: () => void;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  /** Polling interval of the fallback. */
  pollIntervalMs?: number;
  /** Failed connections in a row before polling starts. */
  failuresBeforePolling?: number;
  /** A stream that sends nothing (not even the 15 s heartbeat) this long is dropped and opened again. */
  idleTimeoutMs?: number;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

type Outcome = "delivered" | "empty" | "unauthorized";

export function startLiveFeed<T>(options: LiveFeedOptions<T>): { stop: () => void } {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const pollEvery = options.pollIntervalMs ?? 5_000;
  const pollAfter = options.failuresBeforePolling ?? 3;
  const idleTimeout = options.idleTimeoutMs ?? 45_000;
  const stopper = new AbortController();
  let status: FeedStatus | null = null;

  const setStatus = (next: FeedStatus) => {
    if (next === status) return;
    status = next;
    options.onStatus(next);
  };

  /** One connection; resolves when it ends. "delivered" when at least one state came through. */
  async function streamOnce(refresh: boolean): Promise<Outcome> {
    const token = await options.getToken({ refresh });
    if (stopper.signal.aborted) return "empty";
    if (!token) return "unauthorized";
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    stopper.signal.addEventListener("abort", abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(abort, idleTimeout);
    };
    let delivered = false;
    try {
      armIdle();
      const response = await doFetch(options.streamUrl, {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        credentials: "include",
        cache: "no-store",
        signal: attempt.signal,
      });
      if (attempt.signal.aborted) return "empty";
      if (response.status === 401) return "unauthorized";
      if (!response.ok || !response.body || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) return "empty";
      const reader = response.body.getReader();
      // fetch ends the body on abort by itself; cancelling as well also ends a body that ignores the signal
      attempt.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
      const decoder = new TextDecoder();
      const parser = new SseParser();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        for (const event of parser.push(decoder.decode(value, { stream: true }))) {
          if (event.event !== "state") continue;
          options.onState(JSON.parse(event.data) as T);
          delivered = true;
          setStatus("live");
        }
      }
    } catch {
      // network error, abort or a broken frame: the loop below decides what comes next
    } finally {
      clearTimeout(idle);
      stopper.signal.removeEventListener("abort", abort);
    }
    return delivered ? "delivered" : "empty";
  }

  /** Waits `ms`; once polling, fills the wait with a poll every few seconds. */
  async function wait(ms: number, polling: boolean): Promise<void> {
    if (!polling) {
      await sleep(ms, stopper.signal);
      return;
    }
    let waited = 0;
    while (waited < ms && !stopper.signal.aborted) {
      try {
        options.onState(await options.poll());
      } catch {
        // the API is away too; keep waiting
      }
      if (stopper.signal.aborted) return;
      const step = Math.min(pollEvery, ms - waited);
      await sleep(step, stopper.signal);
      waited += step;
    }
  }

  async function run(): Promise<void> {
    let failures = 0;
    let refresh = false;
    setStatus("connecting");
    while (!stopper.signal.aborted) {
      const outcome = await streamOnce(refresh);
      if (stopper.signal.aborted) break;
      refresh = outcome === "unauthorized";
      failures = outcome === "delivered" ? 1 : failures + 1;
      const polling = failures >= pollAfter;
      setStatus(polling ? "polling" : "reconnecting");
      await wait(backoffDelay(failures - 1, random), polling);
    }
    setStatus("stopped");
    options.onStop?.();
  }

  void run();
  return { stop: () => stopper.abort() };
}
