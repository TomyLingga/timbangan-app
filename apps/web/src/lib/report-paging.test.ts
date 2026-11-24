import { describe, expect, it } from "vitest";

import { lastPage, pageFromParam, pageOffset, pageRangeText, REPORT_PAGE_SIZE, realisedText } from "@/lib/report-paging";

describe("pageFromParam", () => {
  it("reads a whole page number from 1, and falls back to 1 for anything else", () => {
    expect(pageFromParam("3")).toBe(3);
    expect(pageFromParam("")).toBe(1);
    for (const bad of ["0", "-2", "1.5", "x", "2x"]) expect(pageFromParam(bad), bad).toBe(1);
  });
});

describe("pageOffset and lastPage", () => {
  it("turn a page of 50 rows into the offset the API takes, and count the pages", () => {
    expect(REPORT_PAGE_SIZE).toBe(50);
    expect(pageOffset(1)).toBe(0);
    expect(pageOffset(3)).toBe(100);
    expect(lastPage(0)).toBe(1);
    expect(lastPage(50)).toBe(1);
    expect(lastPage(51)).toBe(2);
    expect(lastPage(4052)).toBe(82);
  });
});

describe("pageRangeText", () => {
  it("says which rows of how many are shown", () => {
    expect(pageRangeText(1, 50, 4052)).toBe("1–50 dari 4.052");
    expect(pageRangeText(82, 2, 4052)).toBe("4.051–4.052 dari 4.052");
    expect(pageRangeText(1, 7, 7)).toBe("1–7 dari 7");
    expect(pageRangeText(3, 0, 7)).toBe("0 dari 7");
  });
});

describe("realisedText", () => {
  it("keeps the units apart and says 0 when nothing was realised", () => {
    expect(realisedText([{ uom: "kg", realised: 31000 }])).toBe("31.000 kg");
    expect(realisedText([{ uom: "karton", realised: 120 }, { uom: "kg", realised: 31000.5 }])).toBe("120 karton dan 31.000,5 kg");
    expect(realisedText([])).toBe("0");
  });
});
