import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { backoffMs, type QueueInput, type QueueItem, SendQueue, type Sender, type QueueStorage } from "./queue";

const KEY = "send-queue";

function memoryStorage(initial: Record<string, string> = {}): QueueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: async (key) => data[key] ?? null,
    setItem: async (key, value) => {
      data[key] = value;
    },
  };
}

/** A clock the test moves by hand, with the timers the queue sets. */
function manualClock(start = 1_000_000) {
  let now = start;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return () => {
        const index = timers.indexOf(timer);
        if (index >= 0) timers.splice(index, 1);
      };
    },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((item) => item.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.fn();
      }
    },
  };
}

const input = (n: number, extra: Partial<QueueInput> = {}): QueueInput => ({
  clientUuid: `00000000-0000-4000-8000-00000000000${n}`,
  path: `/api/work/steps/${n}/qc-receiving`,
  body: { disposition: "OK" },
  photos: [],
  label: { form: "QC pass", plate: `ZZ 000${n} CTH`, stepId: n, stepName: "QC pass" },
  values: { ffa: String(n) },
  ...extra,
});

const network = () => new ApiError(0, "NETWORK_ERROR", "x");

async function openQueue(send: Sender, options: { storage?: ReturnType<typeof memoryStorage>; clock?: ReturnType<typeof manualClock>; keepSent?: number } = {}) {
  const storage = options.storage ?? memoryStorage();
  const clock = options.clock ?? manualClock();
  const queue = await SendQueue.open({ storage, send, now: clock.now, schedule: clock.schedule, key: KEY, keepSent: options.keepSent });
  return { queue, storage, clock };
}

const stored = (storage: { data: Record<string, string> }) => JSON.parse(storage.data[KEY] ?? "[]") as QueueItem[];

describe("SendQueue", () => {
  it("stores a submission before sending it", async () => {
    let seenInStorage: QueueItem[] = [];
    const storage = memoryStorage();
    const send = vi.fn<Sender>(async () => {
      seenInStorage = stored(storage);
    });
    const { queue } = await openQueue(send, { storage });
    await queue.enqueue(input(1));
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(seenInStorage.map((item) => item.clientUuid)).toEqual([input(1).clientUuid]);
    expect(queue.items()[0]?.status).toBe("sent");
    expect(stored(storage)[0]?.status).toBe("sent");
  });

  it("sends in the order the forms were saved", async () => {
    const order: string[] = [];
    const { queue } = await openQueue(async (item) => {
      order.push(item.label.plate);
    });
    queue.setOnline(false);
    await queue.enqueue(input(1));
    await queue.enqueue(input(2));
    await queue.enqueue(input(3));
    queue.setOnline(true);
    await queue.flush();
    expect(order).toEqual(["ZZ 0001 CTH", "ZZ 0002 CTH", "ZZ 0003 CTH"]);
  });

  it("keeps a submission waiting after a network failure, holds the ones behind it, and retries after the backoff", async () => {
    let fail = true;
    const order: number[] = [];
    const { queue, clock } = await openQueue(async (item) => {
      if (fail) throw network();
      order.push(item.label.stepId);
    });
    await queue.enqueue(input(1));
    await queue.enqueue(input(2));
    await queue.flush();
    const [first, second] = queue.items();
    expect(first?.status).toBe("waiting");
    expect(first?.attempts).toBe(1);
    expect(first?.lastError?.code).toBe("NETWORK_ERROR");
    expect(first?.nextAttemptAt).toBe(clock.now() + backoffMs(1));
    expect(second?.status).toBe("waiting");
    expect(second?.attempts).toBe(0);
    fail = false;
    clock.advance(backoffMs(1));
    await queue.flush();
    expect(order).toEqual([1, 2]);
    expect(queue.items().every((item) => item.status === "sent")).toBe(true);
  });

  it("retries 5xx with a growing backoff that stops at one minute", async () => {
    const { queue, clock } = await openQueue(async () => {
      throw new ApiError(503, "HTTP_503", "x");
    });
    await queue.enqueue(input(1));
    await queue.flush();
    expect(queue.items()[0]?.nextAttemptAt).toBe(clock.now() + 2_000);
    clock.advance(2_000);
    await queue.flush();
    expect(queue.items()[0]?.attempts).toBe(2);
    expect(queue.items()[0]?.nextAttemptAt).toBe(clock.now() + 4_000);
    expect(backoffMs(10)).toBe(60_000);
  });

  it("drops a 4xx from the sending order with a visible reason and goes on with the next one", async () => {
    const { queue } = await openQueue(async (item) => {
      if (item.label.stepId === 1) throw new ApiError(400, "VALIDATION", "x", { "values.FFA": "FFA harus antara 0 dan 20." });
    });
    await queue.enqueue(input(1));
    await queue.enqueue(input(2));
    await queue.flush();
    const [failed, sent] = queue.items();
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError?.message).toBe("FFA harus antara 0 dan 20.");
    expect(failed?.values).toEqual({ ffa: "1" });
    expect(sent?.status).toBe("sent");
  });

  it("sends again after a restart, with the same uuid, what was waiting or half sent", async () => {
    const half: QueueItem = {
      ...input(1),
      status: "sending",
      attempts: 1,
      createdAt: "2026-11-21T07:00:00.000Z",
      nextAttemptAt: null,
      lastError: null,
      sentAt: null,
    };
    const storage = memoryStorage({ [KEY]: JSON.stringify([half]) });
    const uuids: string[] = [];
    const { queue } = await openQueue(async (item) => {
      uuids.push(item.clientUuid);
    }, { storage });
    await queue.flush();
    expect(uuids).toEqual([half.clientUuid]);
    expect(queue.items()[0]?.status).toBe("sent");
  });

  it("does not send while offline and sends at once when the network is back", async () => {
    const send = vi.fn<Sender>(async () => undefined);
    const { queue } = await openQueue(send);
    queue.setOnline(false);
    await queue.enqueue(input(1));
    await queue.flush();
    expect(send).not.toHaveBeenCalled();
    queue.setOnline(true);
    await queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("tries a backed-off submission at once when the network comes back", async () => {
    let fail = true;
    const { queue } = await openQueue(async () => {
      if (fail) throw network();
    });
    await queue.enqueue(input(1));
    await queue.flush();
    fail = false;
    queue.setOnline(false);
    queue.setOnline(true);
    await queue.flush();
    expect(queue.items()[0]?.status).toBe("sent");
  });

  it("keeps the id of an uploaded photo, so a retry does not upload it again", async () => {
    const seen: (number | null)[] = [];
    let calls = 0;
    const { queue, clock } = await openQueue(async (item, onPhoto) => {
      calls += 1;
      seen.push(item.photos[0]?.fileId ?? null);
      if (calls === 1) {
        onPhoto(0, 77);
        throw network();
      }
    });
    await queue.enqueue(input(1, { photos: [{ uri: "file:///a.jpg", fileId: null }] }));
    await queue.flush();
    clock.advance(backoffMs(1));
    await queue.flush();
    expect(seen).toEqual([null, 77]);
  });

  it("pauses without failing the submission when the session has ended", async () => {
    let signedOut = true;
    const { queue } = await openQueue(async () => {
      if (signedOut) throw new ApiError(401, "SIGNED_OUT", "x");
    });
    await queue.enqueue(input(1));
    await queue.flush();
    expect(queue.items()[0]?.status).toBe("waiting");
    expect(queue.isPaused()).toBe(true);
    signedOut = false;
    queue.setPaused(false);
    await queue.flush();
    expect(queue.items()[0]?.status).toBe("sent");
  });

  it("tells which steps still wait, ignores a second enqueue of the same uuid, and discards on request", async () => {
    const { queue } = await openQueue(async () => undefined);
    queue.setOnline(false);
    await queue.enqueue(input(1));
    await queue.enqueue(input(1));
    expect(queue.items()).toHaveLength(1);
    expect(queue.pendingFor(1)).toBe(true);
    expect(queue.pendingFor(2)).toBe(false);
    await queue.discard(input(1).clientUuid);
    expect(queue.items()).toHaveLength(0);
  });

  it("keeps only the last sent submissions", async () => {
    const { queue } = await openQueue(async () => undefined, { keepSent: 2 });
    for (const n of [1, 2, 3]) await queue.enqueue(input(n));
    await queue.flush();
    expect(queue.items().map((item) => item.label.stepId)).toEqual([2, 3]);
  });

  it("notifies subscribers on every change", async () => {
    const { queue } = await openQueue(async () => undefined);
    const seen: string[] = [];
    queue.subscribe((items) => seen.push(items.map((item) => item.status).join(",")));
    await queue.enqueue(input(1));
    await queue.flush();
    expect(seen).toContain("sent");
    expect(seen[0]).toBe("waiting");
  });
});
