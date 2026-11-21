// The send queue of the phone. Every form submission is stored first (AsyncStorage on the phone), then sent in
// the order it was saved. A failure without an answer, a 5xx, 408 or 429 keeps it waiting and it is tried again
// with a growing pause; any other 4xx takes it out of the sending order as "failed", with the reason, and its
// form values stay so the person can open it again. A submission that was being sent when the app stopped is
// sent again after a restart: the API answers a resend of the same clientUuid with the stored result.
// No React Native imports: storage, network state, clock and timers are given from outside.

import { isApiError, isRetryable, SIGNED_OUT } from "../api/client";
import { formRefusalMessage } from "../api/messages";

export type QueueStatus = "waiting" | "sending" | "failed" | "sent";

export interface QueuedPhoto {
  /** The resized JPEG on the phone. */
  uri: string;
  /** Id from POST /api/files once uploaded. */
  fileId: number | null;
}

export interface QueueLabel {
  /** Name of the form, for the list ("QC pass"). */
  form: string;
  plate: string;
  stepId: number;
  stepName: string;
}

export interface QueueInput {
  clientUuid: string;
  /** POST path, e.g. /api/work/steps/12/qc-receiving. */
  path: string;
  /** The request body without photoFileIds; the sender adds them after the uploads. */
  body: Record<string, unknown>;
  photos: QueuedPhoto[];
  label: QueueLabel;
  /** The form state, to open the form again with its values. */
  values: unknown;
}

export interface QueueItem extends QueueInput {
  status: QueueStatus;
  attempts: number;
  createdAt: string;
  /** Epoch ms before which a waiting item is not tried again. */
  nextAttemptAt: number | null;
  lastError: { status: number; code: string; message: string } | null;
  sentAt: string | null;
}

export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Sends one item. `onPhoto` records an uploaded photo's id, so a retry does not upload it again. */
export type Sender = (item: QueueItem, onPhoto: (index: number, fileId: number) => void) => Promise<unknown>;

export interface QueueOptions {
  storage: QueueStorage;
  send: Sender;
  key?: string;
  now?: () => number;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** How many sent items stay in the list. */
  keepSent?: number;
}

export const QUEUE_KEY = "send-queue-v1";

/** Pause before attempt n+1 after n failed attempts: 2 s, 4 s, 8 s ... at most 60 s. */
export const backoffMs = (attempts: number) => Math.min(2_000 * 2 ** Math.max(0, attempts - 1), 60_000);

const defaultSchedule = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export class SendQueue {
  private list: QueueItem[];
  private online = true;
  private paused = false;
  private loop: Promise<void> | null = null;
  private cancelTimer: (() => void) | null = null;
  private writes: Promise<void> = Promise.resolve();
  private listeners = new Set<(items: QueueItem[]) => void>();
  private readonly storage: QueueStorage;
  private readonly send: Sender;
  private readonly key: string;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => () => void;
  private readonly keepSent: number;

  private constructor(options: QueueOptions, items: QueueItem[]) {
    this.storage = options.storage;
    this.send = options.send;
    this.key = options.key ?? QUEUE_KEY;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.keepSent = options.keepSent ?? 20;
    this.list = items;
  }

  /** Loads what was stored; an item that was being sent when the app stopped waits to be sent again. */
  static async open(options: QueueOptions): Promise<SendQueue> {
    let items: QueueItem[] = [];
    try {
      const text = await options.storage.getItem(options.key ?? QUEUE_KEY);
      const parsed: unknown = text ? JSON.parse(text) : [];
      if (Array.isArray(parsed)) items = parsed as QueueItem[];
    } catch {
      items = [];
    }
    const queue = new SendQueue(options, items.map((item) => (item.status === "sending" ? { ...item, status: "waiting" as const, nextAttemptAt: null } : item)));
    queue.kick();
    return queue;
  }

  items(): QueueItem[] {
    return this.list;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isOnline(): boolean {
    return this.online;
  }

  /** True while a submission for this step is not yet answered by the server. */
  pendingFor(stepId: number): boolean {
    return this.list.some((item) => item.label.stepId === stepId && (item.status === "waiting" || item.status === "sending"));
  }

  subscribe(listener: (items: QueueItem[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async enqueue(input: QueueInput): Promise<void> {
    if (this.list.some((item) => item.clientUuid === input.clientUuid)) return;
    const item: QueueItem = {
      ...input,
      status: "waiting",
      attempts: 0,
      createdAt: new Date(this.now()).toISOString(),
      nextAttemptAt: null,
      lastError: null,
      sentAt: null,
    };
    await this.commit([...this.list, item]);
    this.kick();
  }

  async discard(clientUuid: string): Promise<void> {
    await this.commit(this.list.filter((item) => item.clientUuid !== clientUuid || item.status === "sending"));
  }

  setOnline(online: boolean): void {
    const cameBack = online && !this.online;
    this.online = online;
    if (cameBack) this.retryNow();
  }

  /** Paused while there is no session; nothing is sent until it is resumed. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    this.notify();
    if (!paused) this.kick();
  }

  /** Tries the waiting submissions now instead of after their pause. */
  retryNow(): void {
    this.list = this.list.map((item) => (item.status === "waiting" ? { ...item, nextAttemptAt: null } : item));
    this.notify();
    this.kick();
  }

  /** Resolves when the queue has nothing it can send right now. */
  async flush(): Promise<void> {
    this.kick();
    while (this.loop) await this.loop;
    await this.writes;
  }

  private kick(): void {
    if (this.loop) return;
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  private async run(): Promise<void> {
    this.cancelTimer?.();
    this.cancelTimer = null;
    for (;;) {
      if (!this.online || this.paused) return;
      const item = this.list.find((entry) => entry.status === "waiting");
      if (!item) return;
      const wait = (item.nextAttemptAt ?? 0) - this.now();
      if (wait > 0) {
        this.cancelTimer = this.schedule(() => this.kick(), wait);
        return;
      }
      await this.attempt(item.clientUuid);
    }
  }

  private async attempt(clientUuid: string): Promise<void> {
    await this.update(clientUuid, { status: "sending" });
    const current = this.find(clientUuid);
    if (!current) return;
    try {
      await this.send(current, (index, fileId) => {
        const photos = (this.find(clientUuid)?.photos ?? []).map((photo, at) => (at === index ? { ...photo, fileId } : photo));
        void this.update(clientUuid, { photos });
      });
      await this.update(clientUuid, { status: "sent", sentAt: new Date(this.now()).toISOString(), lastError: null, nextAttemptAt: null });
      await this.pruneSent();
    } catch (error) {
      const lastError = {
        status: isApiError(error) ? error.status : 0,
        code: isApiError(error) ? error.code : "UNKNOWN",
        message: formRefusalMessage(error),
      };
      if (isApiError(error) && error.code === SIGNED_OUT) {
        await this.update(clientUuid, { status: "waiting", lastError });
        this.paused = true;
        this.notify();
        return;
      }
      if (isRetryable(error) || !isApiError(error)) {
        // an error without an answer from the API (a photo that could not be read, say) is also tried again
        const attempts = (this.find(clientUuid)?.attempts ?? 0) + 1;
        await this.update(clientUuid, { status: "waiting", attempts, nextAttemptAt: this.now() + backoffMs(attempts), lastError });
        return;
      }
      await this.update(clientUuid, { status: "failed", attempts: (this.find(clientUuid)?.attempts ?? 0) + 1, lastError, nextAttemptAt: null });
    }
  }

  private find(clientUuid: string): QueueItem | undefined {
    return this.list.find((item) => item.clientUuid === clientUuid);
  }

  private async update(clientUuid: string, changes: Partial<QueueItem>): Promise<void> {
    await this.commit(this.list.map((item) => (item.clientUuid === clientUuid ? { ...item, ...changes } : item)));
  }

  private async pruneSent(): Promise<void> {
    const sent = this.list.filter((item) => item.status === "sent");
    if (sent.length <= this.keepSent) return;
    const drop = new Set(sent.slice(0, sent.length - this.keepSent).map((item) => item.clientUuid));
    await this.commit(this.list.filter((item) => !drop.has(item.clientUuid)));
  }

  /** Replaces the list, writes it to storage (writes in order), then tells the listeners. */
  private async commit(next: QueueItem[]): Promise<void> {
    this.list = next;
    const text = JSON.stringify(next);
    this.writes = this.writes.then(() => this.storage.setItem(this.key, text)).catch(() => undefined);
    await this.writes;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.list);
  }
}
