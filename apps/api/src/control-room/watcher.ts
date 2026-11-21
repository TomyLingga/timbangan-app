// One watcher per process for the control room's live feed. While at least one client listens it recomputes the
// state every interval (the next round starts after the previous one finished, so rounds never overlap) and sends it
// only when it changed; a comment line keeps idle connections open through proxies. With no client left it stops.
import { createHash } from "node:crypto";

export interface WatcherOptions<T> {
  compute: () => Promise<T>;
  intervalMs: number;
  heartbeatMs: number;
  onError?: (error: unknown) => void;
}

/** A frame of the event stream, ready to write. */
export type Send = (frame: string) => void;

export const HEARTBEAT_FRAME = ": heartbeat\n\n";

/** The state without its generation time, so a new timestamp alone is not a change. */
function fingerprint(state: unknown): string {
  const stable = state !== null && typeof state === "object" ? { ...(state as Record<string, unknown>), generatedAt: undefined } : state;
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export class StateWatcher<T> {
  private readonly listeners = new Set<Send>();
  private timer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  /** Bumped on every start and stop, so a round that finishes after a stop is dropped. */
  private generation = 0;
  private lastHash: string | null = null;
  private lastFrame: string | null = null;

  constructor(private readonly options: WatcherOptions<T>) {}

  get running(): boolean {
    return this.listeners.size > 0;
  }

  get clients(): number {
    return this.listeners.size;
  }

  /** Adds a client; it gets the last state at once when there is one. Answers the function that removes it. */
  subscribe(send: Send): () => void {
    this.listeners.add(send);
    if (this.listeners.size === 1) this.start();
    else if (this.lastFrame) send(this.lastFrame);
    return () => {
      if (!this.listeners.delete(send)) return;
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Drops every client and stops. */
  stop(): void {
    this.listeners.clear();
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
    this.lastHash = null;
    this.lastFrame = null;
  }

  private start(): void {
    const generation = ++this.generation;
    this.heartbeat = setInterval(() => this.broadcast(HEARTBEAT_FRAME), this.options.heartbeatMs);
    void this.round(generation);
  }

  private async round(generation: number): Promise<void> {
    try {
      const state = await this.options.compute();
      if (generation !== this.generation) return;
      const hash = fingerprint(state);
      if (hash !== this.lastHash) {
        this.lastHash = hash;
        this.lastFrame = `event: state\ndata: ${JSON.stringify(state)}\n\n`;
        this.broadcast(this.lastFrame);
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.options.onError?.(error);
    }
    this.timer = setTimeout(() => void this.round(generation), this.options.intervalMs);
  }

  private broadcast(frame: string): void {
    for (const send of [...this.listeners]) {
      try {
        send(frame);
      } catch (error) {
        this.options.onError?.(error);
      }
    }
  }
}
