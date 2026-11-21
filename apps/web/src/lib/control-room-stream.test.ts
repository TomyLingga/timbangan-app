import { describe, expect, it } from "vitest";

import { backoffDelay, type FeedStatus, SseParser, startLiveFeed } from "@/lib/control-room-stream";

describe("SseParser", () => {
  it("reads events split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("event: state\nda")).toEqual([]);
    expect(parser.push('ta: {"n":1}\n')).toEqual([]);
    expect(parser.push("\nevent: state\ndata: 2\n\n")).toEqual([
      { event: "state", data: '{"n":1}' },
      { event: "state", data: "2" },
    ]);
  });

  it("skips comments, joins data lines and takes CRLF line ends", () => {
    const parser = new SseParser();
    expect(parser.push(": connected\r\n\r\n: heartbeat\n\ndata: a\r\ndata:b\r\nid: 7\r\n\r\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("ignores a block with no data", () => {
    expect(new SseParser().push("event: state\n\n")).toEqual([]);
  });
});

describe("backoffDelay", () => {
  it("doubles from one second up to thirty, with up to half taken off at random", () => {
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(10, () => 1)).toBe(30000);
    expect(backoffDelay(10, () => 0)).toBe(15000);
  });
});

/** A body that sends the given chunks and then ends (or stays open). */
function streamBody(chunks: string[], { stayOpen = false } = {}) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (!stayOpen) controller.close();
    },
  });
}

const eventStream = (body: ReadableStream<Uint8Array>) => new Response(body, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });

interface Harness {
  statuses: FeedStatus[];
  states: unknown[];
  requests: { url: string; authorization: string | null }[];
  slept: number[];
  tokens: { refresh: boolean }[];
  polls: number;
}

function harness(answers: Array<() => Response | Promise<Response>>, options: { maxSleeps?: number } = {}) {
  const h: Harness = { statuses: [], states: [], requests: [], slept: [], tokens: [], polls: 0 };
  let call = 0;
  let stopFeed = () => {};
  const done = new Promise<void>((resolve) => {
    const feed = startLiveFeed<unknown>({
      streamUrl: "http://api.test/api/control-room/stream",
      getToken: async (opts) => {
        h.tokens.push({ refresh: opts?.refresh ?? false });
        return opts?.refresh ? "fresh-token" : "token";
      },
      poll: async () => {
        h.polls++;
        return { polled: h.polls };
      },
      onState: (state) => h.states.push(state),
      onStatus: (status) => h.statuses.push(status),
      fetch: async (input, init) => {
        h.requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
        const answer = answers[Math.min(call++, answers.length - 1)];
        return answer();
      },
      sleep: async (ms) => {
        h.slept.push(ms);
        // the feed then ends its loop and calls onStop, which resolves `done`
        if (h.slept.length >= (options.maxSleeps ?? 20)) feed.stop();
      },
      random: () => 1,
      onStop: () => resolve(),
    });
    stopFeed = feed.stop;
  });
  return { h, done, stop: () => stopFeed() };
}

describe("startLiveFeed", () => {
  it("sends the bearer token, hands over each state and says it is live", async () => {
    const { h, done } = harness([() => eventStream(streamBody(['event: state\ndata: {"n":1}\n\n', ": heartbeat\n\n", 'event: state\ndata: {"n":2}\n\n']))], { maxSleeps: 1 });
    await done;
    expect(h.requests[0]).toEqual({ url: "http://api.test/api/control-room/stream", authorization: "Bearer token" });
    expect(h.states.slice(0, 2)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(h.statuses.slice(0, 3)).toEqual(["connecting", "live", "reconnecting"]);
  });

  it("reconnects with a growing wait after the stream ends without having delivered", async () => {
    const { h, done } = harness([() => eventStream(streamBody([": connected\n\n"]))], { maxSleeps: 2 });
    await done;
    expect(h.slept).toEqual([1000, 2000]);
    expect(h.requests).toHaveLength(2);
  });

  it("starts the wait from one second again once a stream delivered a state", async () => {
    const { h, done } = harness(
      [
        () => eventStream(streamBody([": connected\n\n"])),
        () => eventStream(streamBody(['event: state\ndata: {"n":1}\n\n'])),
        () => eventStream(streamBody([": connected\n\n"])),
      ],
      { maxSleeps: 3 },
    );
    await done;
    expect(h.slept).toEqual([1000, 1000, 2000]);
  });

  it("asks for a fresh token after a 401", async () => {
    const { h, done } = harness([() => new Response("{}", { status: 401 }), () => eventStream(streamBody(['event: state\ndata: {"n":1}\n\n']))], { maxSleeps: 2 });
    await done;
    expect(h.tokens.slice(0, 2)).toEqual([{ refresh: false }, { refresh: true }]);
    expect(h.requests[1]?.authorization).toBe("Bearer fresh-token");
    expect(h.states[0]).toEqual({ n: 1 });
  });

  it("polls the state every five seconds after three failed connections, while it keeps trying the stream", async () => {
    const { h, done } = harness([() => Promise.reject(new TypeError("network down"))], { maxSleeps: 6 });
    await done;
    // two short waits, then the third failure switches to polling: the 4 s wait is filled with polls
    expect(h.slept.slice(0, 2)).toEqual([1000, 2000]);
    expect(h.statuses).toContain("polling");
    expect(h.polls).toBeGreaterThan(0);
    expect(h.states[0]).toEqual({ polled: 1 });
    expect(h.slept.slice(2).every((ms) => ms <= 5000)).toBe(true);
  });

  it("treats an answer that is not an event stream as a failure", async () => {
    const { h, done } = harness([() => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } })], { maxSleeps: 1 });
    await done;
    expect(h.states).toEqual([]);
    expect(h.statuses).toEqual(["connecting", "reconnecting", "stopped"]);
  });

  it("stops without another request", async () => {
    const { h, done, stop } = harness([() => eventStream(streamBody(['event: state\ndata: {"n":1}\n\n'], { stayOpen: true }))]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    await done;
    expect(h.requests).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("stopped");
  });
});
