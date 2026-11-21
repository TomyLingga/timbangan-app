import { describe, expect, it } from "vitest";
import { CAMERA_COUNT, cameraLabel, initialCameras, onlineCount, recordCamera } from "../src/shared/cameras";

describe("four plate cameras", () => {
  it("starts with four unknown cameras, none online", () => {
    const state = initialCameras();
    expect(state).toHaveLength(CAMERA_COUNT);
    expect(state.map((reading) => [reading.camera, reading.status, reading.plate])).toEqual([
      [1, "unknown", null],
      [2, "unknown", null],
      [3, "unknown", null],
      [4, "unknown", null],
    ]);
    expect(onlineCount(state)).toBe(0);
  });

  it("names the cameras by direction and stage", () => {
    expect([1, 2, 3, 4].map(cameraLabel)).toEqual(["Outgoing · timbang 1", "Outgoing · timbang 2", "Incoming · timbang 1", "Incoming · timbang 2"]);
  });

  it("records each answer, an empty text as not read, and counts online and lagging cameras", () => {
    let state = initialCameras();
    state = recordCamera(state, 1, { plate: "XX1234AB", status: "online" }, 1_000);
    state = recordCamera(state, 2, { plate: "", status: "lagging" }, 1_000);
    state = recordCamera(state, 3, { plate: "", status: "offline" }, 1_000);
    expect(state[0]).toEqual({ camera: 1, plate: "XX1234AB", status: "online", at: 1_000 });
    expect(state[1]).toEqual({ camera: 2, plate: null, status: "lagging", at: 1_000 });
    expect(onlineCount(state)).toBe(2);
  });

  it("counts a reader that does not answer as offline, and keeps no old text", () => {
    let state = recordCamera(initialCameras(), 4, { plate: "XX1234AB", status: "online" }, 1_000);
    state = recordCamera(state, 4, null, 2_000);
    expect(state[3]).toEqual({ camera: 4, plate: null, status: "unreachable", at: 2_000 });
    expect(onlineCount(state)).toBe(0);
  });

  it("ignores a camera number outside 1 to 4", () => {
    const state = initialCameras();
    expect(recordCamera(state, 9, { plate: "X", status: "online" }, 1)).toBe(state);
  });
});
