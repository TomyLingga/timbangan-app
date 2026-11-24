import { describe, expect, it } from "vitest";

import { isPlanImageType, isSafePlanSvg, planAspect, planBackdrop, planImagePath } from "@/lib/control-room-plan";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 916 506" fill="none" stroke="currentColor"><g><rect x="1" y="1" width="9" height="9"/></g></svg>';

describe("isSafePlanSvg", () => {
  it("accepts a drawing of plain shapes", () => {
    expect(isSafePlanSvg(SVG)).toBe(true);
    expect(isSafePlanSvg(`<?xml version="1.0"?>\n<!-- plan -->\n${SVG}`)).toBe(true);
  });

  it.each([
    '<svg viewBox="0 0 1 1"><script>x()</script></svg>',
    '<svg viewBox="0 0 1 1"><rect onload="x()"/></svg>',
    '<svg viewBox="0 0 1 1"><use href="https://example.invalid/a#b"/></svg>',
    '<svg viewBox="0 0 1 1"><foreignObject/></svg>',
    '<svg viewBox="0 0 1 1"><rect style="fill:url(http://x)"/></svg>',
    '<!DOCTYPE svg><svg viewBox="0 0 1 1"/>',
    "<div>not a drawing</div>",
  ])("refuses %s", (text) => {
    expect(isSafePlanSvg(text)).toBe(false);
  });
});

describe("planAspect", () => {
  it("reads width over height from the viewBox", () => {
    expect(planAspect(SVG)).toEqual({ width: 916, height: 506 });
    expect(planAspect("<svg/>")).toBeNull();
  });
});

describe("planBackdrop", () => {
  it("uses the picture and its pixel size when the state announces one", () => {
    expect(planBackdrop({ width: 916, height: 506, version: "abc" }, { width: 1000, height: 560 })).toEqual({ kind: "image", width: 916, height: 506 });
  });

  it("falls back to the drawing, then to a plain box of the demo plan's shape", () => {
    expect(planBackdrop(null, { width: 916, height: 506 })).toEqual({ kind: "svg", width: 916, height: 506 });
    expect(planBackdrop(undefined, null)).toEqual({ kind: "none", width: 1000, height: 560 });
  });

  it("ignores a picture without a usable size", () => {
    expect(planBackdrop({ width: 0, height: 506, version: "abc" }, null)).toEqual({ kind: "none", width: 1000, height: 560 });
  });
});

describe("plan picture", () => {
  it("is asked for with its version, so a new import is not served from the cache", () => {
    expect(planImagePath("0123abcd")).toBe("/api/control-room/plan-image?v=0123abcd");
    expect(planImagePath("a b&c")).toBe("/api/control-room/plan-image?v=a%20b%26c");
  });

  it("is shown only when the answer is a PNG or a JPEG", () => {
    expect(isPlanImageType("image/png")).toBe(true);
    expect(isPlanImageType("image/jpeg")).toBe(true);
    expect(isPlanImageType("image/svg+xml")).toBe(false);
    expect(isPlanImageType("text/html")).toBe(false);
    expect(isPlanImageType("")).toBe(false);
  });
});
