import { describe, expect, it } from "vitest";
import { resizeTarget } from "./resize";

describe("resizeTarget", () => {
  it("shrinks the long side to 1600", () => {
    expect(resizeTarget(4000, 3000)).toEqual({ width: 1600 });
    expect(resizeTarget(3000, 4000)).toEqual({ height: 1600 });
    expect(resizeTarget(2000, 2000)).toEqual({ width: 1600 });
  });
  it("leaves a small photo alone", () => {
    expect(resizeTarget(1600, 1200)).toBeNull();
    expect(resizeTarget(800, 600)).toBeNull();
    expect(resizeTarget(0, 0)).toBeNull();
  });
});
