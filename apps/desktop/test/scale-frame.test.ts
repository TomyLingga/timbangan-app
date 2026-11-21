import { describe, expect, it } from "vitest";
import { createFrameParser, parseFrameLine } from "../src/shared/scale-frame";

describe("parseFrameLine", () => {
  it("takes the number after the 99 marker as whole kilograms", () => {
    expect(parseFrameLine("ST,GS 99 41500 kg")).toBe(41_500);
    expect(parseFrameLine("99 00012340")).toBe(12_340);
  });

  it("keeps only the digits of the first token after the marker", () => {
    expect(parseFrameLine("ST 99 +041500kg  extra")).toBe(41_500);
  });

  it("reads a leading minus as a negative weight", () => {
    expect(parseFrameLine("ST 99 -120 kg")).toBe(-120);
  });

  it("ignores a line without the marker, without a number, or with nulls only", () => {
    expect(parseFrameLine("ST,GS 41500 kg")).toBeNull();
    expect(parseFrameLine("ST 99 kg")).toBeNull();
    expect(parseFrameLine("\u0000\u0000")).toBeNull();
    expect(parseFrameLine("")).toBeNull();
  });

  it("drops null characters before reading", () => {
    expect(parseFrameLine("\u0000ST 99 4\u000050\u0000")).toBe(450);
  });
});

describe("createFrameParser", () => {
  it("joins a line split across chunks and gives one weight per complete line", () => {
    const parser = createFrameParser();
    expect(parser.push("ST 99 41")).toEqual([]);
    expect(parser.push("500 kg\r\nST 99 415")).toEqual([41_500]);
    expect(parser.push("20 kg\r\n")).toEqual([41_520]);
  });

  it("accepts CR, LF and CRLF line ends and skips noise lines", () => {
    const parser = createFrameParser();
    expect(parser.push("ST 99 100\rgarbage\nST 99 200\r\n\r\nST 99 300\n")).toEqual([100, 200, 300]);
  });

  it("throws away a runaway buffer without a line end", () => {
    const parser = createFrameParser({ maxLineLength: 32 });
    expect(parser.push("x".repeat(40))).toEqual([]);
    expect(parser.push("\nST 99 500\n")).toEqual([500]);
  });
});
