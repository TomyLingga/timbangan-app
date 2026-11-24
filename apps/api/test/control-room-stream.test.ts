// The live feed of the control room: one shared watcher per process recomputes the state while clients listen,
// sends it only when it changed, keeps the line open with comments, and stops when the last client leaves.
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createGuards } from "../src/auth/guard.js";
import { SyncLock } from "../src/sync/lock.js";
import { registerControlRoomRoutes } from "../src/control-room/routes.js";
import { StateWatcher } from "../src/control-room/watcher.js";
import { errorHandler, notFoundHandler } from "../src/errors.js";
import { testApp } from "./helpers/app.js";
import { bearer, seedStaff } from "./helpers/users.js";
import { seedBase, seedTrip } from "./control-room-fixtures.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the check passes or the time is up. */
async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await wait(10);
  }
}

describe("StateWatcher", () => {
  const watchers: StateWatcher<unknown>[] = [];
  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.stop();
  });

  function watcherOf(values: unknown[], options: { intervalMs?: number; heartbeatMs?: number } = {}) {
    let calls = 0;
    const watcher = new StateWatcher<unknown>({
      compute: async () => values[Math.min(calls++, values.length - 1)],
      intervalMs: options.intervalMs ?? 20,
      heartbeatMs: options.heartbeatMs ?? 60_000,
    });
    watchers.push(watcher);
    return { watcher, calls: () => calls };
  }

  it("computes nothing until a client listens", async () => {
    const { watcher, calls } = watcherOf([{ n: 1 }]);
    await wait(60);
    expect(calls()).toBe(0);
    expect(watcher.running).toBe(false);
  });

  it("sends the first state at once and again only after it changed", async () => {
    const { watcher, calls } = watcherOf([{ n: 1, generatedAt: "a" }, { n: 1, generatedAt: "b" }, { n: 1, generatedAt: "c" }, { n: 2, generatedAt: "d" }]);
    const frames: string[] = [];
    watcher.subscribe((frame) => frames.push(frame));
    await until(() => calls() >= 5);
    // generatedAt alone is no change
    expect(frames.filter((frame) => frame.startsWith("event: state"))).toEqual([
      `event: state\ndata: ${JSON.stringify({ n: 1, generatedAt: "a" })}\n\n`,
      `event: state\ndata: ${JSON.stringify({ n: 2, generatedAt: "d" })}\n\n`,
    ]);
  });

  it("gives a client that joins later the last state without waiting for a change", async () => {
    const { watcher, calls } = watcherOf([{ n: 7 }]);
    watcher.subscribe(() => {});
    await until(() => calls() >= 2);
    const late: string[] = [];
    watcher.subscribe((frame) => late.push(frame));
    expect(late).toEqual([`event: state\ndata: ${JSON.stringify({ n: 7 })}\n\n`]);
  });

  it("sends a comment heartbeat", async () => {
    const { watcher } = watcherOf([{ n: 1 }], { heartbeatMs: 30 });
    const frames: string[] = [];
    watcher.subscribe((frame) => frames.push(frame));
    await until(() => frames.some((frame) => frame === ": heartbeat\n\n"));
  });

  it("stops computing when the last client leaves and starts fresh with the next one", async () => {
    const { watcher, calls } = watcherOf([{ n: 1 }]);
    const leaveA = watcher.subscribe(() => {});
    const leaveB = watcher.subscribe(() => {});
    await until(() => calls() >= 2);
    leaveA();
    expect(watcher.running).toBe(true);
    leaveB();
    expect(watcher.running).toBe(false);
    const stoppedAt = calls();
    await wait(80);
    expect(calls()).toBe(stoppedAt);

    const frames: string[] = [];
    watcher.subscribe((frame) => frames.push(frame));
    await until(() => frames.length > 0);
    expect(frames[0]).toBe(`event: state\ndata: ${JSON.stringify({ n: 1 })}\n\n`);
  });

  it("keeps running after a failed computation", async () => {
    let calls = 0;
    const failures: unknown[] = [];
    const watcher = new StateWatcher<unknown>({
      compute: async () => {
        calls++;
        if (calls === 1) throw new Error("database gone for a moment");
        return { n: calls > 2 ? 2 : 1 };
      },
      intervalMs: 20,
      heartbeatMs: 60_000,
      onError: (error) => failures.push(error),
    });
    watchers.push(watcher);
    const frames: string[] = [];
    watcher.subscribe((frame) => frames.push(frame));
    await until(() => frames.length >= 2);
    expect(failures).toHaveLength(1);
  });
});

describe("GET /api/control-room/stream", () => {
  /** The real application for the database and sign-in, and a second one with only these routes and a short interval. */
  async function streaming() {
    const ctx = await testApp();
    const base = await seedBase(ctx.database);
    await seedStaff(ctx.database, "layar", { dashboard: "VIEW" });
    const headers = await bearer(ctx.app, "layar");
    const app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    app.setNotFoundHandler(notFoundHandler);
    app.decorateRequest("account", null);
    // a still clock: the minutes in the state do not tick during the test
    const now = new Date("2026-11-20T03:00:00Z");
    const context = { config: ctx.config, database: ctx.database, now: () => now, vcf: null, registryPushTimeoutMs: 0, syncLock: new SyncLock(), push: null };
    const { watcher } = registerControlRoomRoutes(app, context, createGuards(context), { intervalMs: 40, heartbeatMs: 60_000 });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    return { ...ctx, base, headers, watcher, address, close: () => app.close() };
  }

  /** Reads frames from an open event stream into `frames`. */
  async function listen(response: Response, frames: string[]) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          frames.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
        }
      }
    } catch {
      // aborted by the test
    }
  }

  const states = (frames: string[]) =>
    frames.filter((frame) => frame.startsWith("event: state")).map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)) as { trucks: { zone: string }[] });

  it("sends the state as server-sent events, again after a change, and stops watching when the client leaves", async () => {
    const { database, base, headers, watcher, address, close } = await streaming();
    try {
      const { tripId } = await seedTrip(database, base, { plate: "ZZ 2001 AA", steps: [{ code: "WEIGH_1", status: "READY", readyAt: "2026-11-20T01:00:00Z" }] });
      const abort = new AbortController();
      const response = await fetch(`${address}/api/control-room/stream`, { headers, signal: abort.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
      const frames: string[] = [];
      const reading = listen(response, frames);

      await until(() => states(frames).length === 1);
      expect(states(frames)[0]?.trucks.map((truck) => truck.zone)).toEqual(["QUEUE"]);
      expect(watcher.running).toBe(true);

      // several rounds without a change send nothing new
      await wait(200);
      expect(states(frames)).toHaveLength(1);

      await database.query("update trip_steps set status = 'DONE', started_at = '2026-11-20T02:00:00Z', finished_at = '2026-11-20T02:00:00Z' where trip_id = $1", [tripId]);
      await until(() => states(frames).length === 2);
      expect(states(frames)[1]?.trucks.map((truck) => truck.zone)).toEqual(["REG"]);

      abort.abort();
      await reading;
      await until(() => !watcher.running);
    } finally {
      await close();
    }
  });

  it("shares one watcher between clients and closes open streams when the server stops", async () => {
    const { headers, watcher, address, close } = await streaming();
    const first = await fetch(`${address}/api/control-room/stream`, { headers });
    const second = await fetch(`${address}/api/control-room/stream`, { headers });
    const framesA: string[] = [];
    const framesB: string[] = [];
    const readingA = listen(first, framesA);
    const readingB = listen(second, framesB);
    await until(() => states(framesA).length === 1 && states(framesB).length === 1);
    expect(watcher.clients).toBe(2);
    await close();
    await Promise.all([readingA, readingB]);
    expect(watcher.running).toBe(false);
  });
});
