import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { createDeviceRegistrar, devicePath, foregroundBehavior, parsePushData, presentedForException, pushEvents, pushTarget, tagOf } from "./push";

// data as the API sends it (apps/api/src/notifications/sender.ts): every value a string
const raised = { type: "EXCEPTION_RAISED", notificationId: "41", exceptionId: "901", tripId: "112" };
const closed = { type: "EXCEPTION_CLOSED", notificationId: "42", exceptionId: "901", tripId: "112" };
const doSent = { type: "DO_SENT", notificationId: "43", deliveryOrderId: "7" };

describe("push data", () => {
  it("reads the string ids of each push type", () => {
    expect(parsePushData(raised)).toEqual({ type: "EXCEPTION_RAISED", notificationId: 41, exceptionId: 901, tripId: 112, deliveryOrderId: null });
    expect(parsePushData(closed)?.exceptionId).toBe(901);
    expect(parsePushData(doSent)).toEqual({ type: "DO_SENT", notificationId: 43, exceptionId: null, tripId: null, deliveryOrderId: 7 });
  });
  it("reads a tap on a notification Android showed itself: the data among the intent extras", () => {
    expect(parsePushData({ ...raised, "google.message_id": "0:1", "google.sent_time": 1, from: "123" })?.exceptionId).toBe(901);
  });
  it("reads a JSON dataString", () => {
    expect(parsePushData({ dataString: JSON.stringify(raised) })?.exceptionId).toBe(901);
  });
  it("ignores what is not ours", () => {
    expect(parsePushData(null)).toBeNull();
    expect(parsePushData({})).toBeNull();
    expect(parsePushData({ dataString: "not json" })).toBeNull();
    expect(parsePushData({ type: "EXCEPTION_RAISED", exceptionId: "abc" })?.exceptionId).toBeNull();
  });
});

describe("what to do per push type", () => {
  it("a tap on a request opens its decision screen; anything else the inbox", () => {
    expect(pushTarget(parsePushData(raised))).toEqual({ kind: "decision", exceptionId: 901 });
    expect(pushTarget(parsePushData(closed))).toEqual({ kind: "inbox" });
    expect(pushTarget(parsePushData(doSent))).toEqual({ kind: "inbox" });
    expect(pushTarget(parsePushData({ type: "EXCEPTION_RAISED" }))).toEqual({ kind: "inbox" });
    expect(pushTarget(null)).toEqual({ kind: "inbox" });
  });
  it("in the foreground a request is shown with sound, a delivery order quietly, a closed request not at all", () => {
    expect(foregroundBehavior(parsePushData(raised), true)).toEqual({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false });
    expect(foregroundBehavior(parsePushData(doSent), true)).toMatchObject({ shouldShowBanner: true, shouldPlaySound: false });
    expect(foregroundBehavior(parsePushData(closed), false)).toMatchObject({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false });
    expect(foregroundBehavior(null, false).shouldShowList).toBe(false);
  });
});

describe("shown notifications of a request", () => {
  const presented = [
    { identifier: "expo-notifications://foreign_notifications?tag=exception-901&id=0", data: {} },
    { identifier: "expo-notifications://foreign_notifications?tag=exception-902&id=0", data: {} },
    { identifier: "0:1700000000%abc", data: raised },
    { identifier: "0:1700000001%def", data: { ...raised, exceptionId: "903" } },
    { identifier: "expo-notifications://foreign_notifications?id=5", data: {} },
  ];
  it("finds the tag Android gave it and the ones the app showed with the request in the data", () => {
    expect(tagOf(presented[0]!.identifier)).toBe("exception-901");
    expect(tagOf(presented[4]!.identifier)).toBeNull();
    expect(presentedForException(901, presented)).toEqual(["expo-notifications://foreign_notifications?tag=exception-901&id=0", "0:1700000000%abc"]);
  });
  it("leaves out the reminder that just arrived", () => {
    expect(presentedForException(901, presented, "0:1700000000%abc")).toEqual(["expo-notifications://foreign_notifications?tag=exception-901&id=0"]);
  });
  it("does not take a request whose id only starts the same", () => {
    expect(presentedForException(90, presented)).toEqual([]);
  });
});

function fakeApi(fail: (path: string, method: string | undefined) => boolean = () => false) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api = {
    request: vi.fn(async (path: string, options: { method?: string; body?: unknown } = {}) => {
      calls.push({ path, method: options.method, body: options.body });
      if (fail(path, options.method)) throw new ApiError(0, "NETWORK_ERROR", "The API could not be reached");
      return options.method === "DELETE" ? undefined : { device: { id: 1 } };
    }),
  };
  return { api: api as never, calls };
}

describe("device registration", () => {
  it("sends the token with the platform and the app version once per account", async () => {
    const { api, calls } = fakeApi();
    const registrar = createDeviceRegistrar();
    await registrar.sync(api, "tok-1", "0.2.0", 1);
    await registrar.sync(api, "tok-1", "0.2.0", 1);
    expect(calls).toEqual([{ path: "/api/devices", method: "POST", body: { platform: "ANDROID", pushToken: "tok-1", appVersion: "0.2.0" } }]);
    expect(registrar.current()).toBe("tok-1");
  });
  it("sends again when the token changes or another account signs in", async () => {
    const { api, calls } = fakeApi();
    const registrar = createDeviceRegistrar();
    await registrar.sync(api, "tok-1", "0.2.0", 1);
    await registrar.sync(api, "tok-2", "0.2.0", 1);
    await registrar.sync(api, "tok-2", "0.2.0", 2);
    expect(calls.map((call) => (call.body as { pushToken: string }).pushToken)).toEqual(["tok-1", "tok-2", "tok-2"]);
  });
  it("tries again after a failed send", async () => {
    let down = true;
    const { api, calls } = fakeApi(() => down);
    const registrar = createDeviceRegistrar();
    await expect(registrar.sync(api, "tok-1", null, 1)).rejects.toThrow();
    expect(registrar.current()).toBeNull();
    down = false;
    await registrar.sync(api, "tok-1", null, 1);
    expect(calls).toHaveLength(2);
    expect(registrar.current()).toBe("tok-1");
  });
  it("runs one call at a time, so a token change during the first send is not lost", async () => {
    const { api, calls } = fakeApi();
    const registrar = createDeviceRegistrar();
    await Promise.all([registrar.sync(api, "tok-1", null, 1), registrar.sync(api, "tok-2", null, 1)]);
    expect(calls.map((call) => (call.body as { pushToken: string }).pushToken)).toEqual(["tok-1", "tok-2"]);
    expect(registrar.current()).toBe("tok-2");
  });
  it("removes the token at sign-out with the token URL-encoded", async () => {
    const { api, calls } = fakeApi();
    const registrar = createDeviceRegistrar();
    await registrar.sync(api, "abc:DEF/ghi+1", null, 1);
    await registrar.unregister(api);
    expect(calls[1]).toEqual({ path: "/api/devices/abc%3ADEF%2Fghi%2B1", method: "DELETE", body: undefined });
    expect(devicePath("a b")).toBe("/api/devices/a%20b");
    expect(registrar.current()).toBeNull();
  });
  it("a failed removal does not stop the sign-out", async () => {
    const { api } = fakeApi((_path, method) => method === "DELETE");
    const registrar = createDeviceRegistrar();
    await registrar.sync(api, "tok-1", null, 1);
    await expect(registrar.unregister(api)).resolves.toBeUndefined();
    expect(registrar.current()).toBeNull();
  });
  it("without a token sent in this run it asks the phone for its token; without one it sends nothing", async () => {
    const { api, calls } = fakeApi();
    const registrar = createDeviceRegistrar();
    await registrar.unregister(api, async () => "tok-9");
    expect(calls).toEqual([{ path: "/api/devices/tok-9", method: "DELETE", body: undefined }]);
    await registrar.unregister(api);
    await registrar.unregister(api, async () => {
      throw new Error("no Firebase");
    });
    expect(calls).toHaveLength(1);
  });
});

describe("push events", () => {
  it("reaches every listener until it unsubscribes, past a broken one", () => {
    const seen: string[] = [];
    const stopBroken = pushEvents.subscribe(() => {
      throw new Error("broken");
    });
    const stop = pushEvents.subscribe((data) => seen.push(data.type));
    pushEvents.emit(parsePushData(closed)!);
    stop();
    stopBroken();
    pushEvents.emit(parsePushData(raised)!);
    expect(seen).toEqual(["EXCEPTION_CLOSED"]);
  });
});
