// WAV encoding of the engine's samples and the level raise (pure).
import { describe, expect, it } from "vitest";
import { encodeWav, raiseLevel, TARGET_PEAK } from "../src/speech/wav.js";

describe("raiseLevel", () => {
  it("scales quiet audio up to the target peak without clipping", () => {
    const raised = raiseLevel(new Float32Array([0, 0.2, -0.4, 0.1]));
    expect(Math.max(...raised.map(Math.abs))).toBeCloseTo(TARGET_PEAK, 5);
    expect(raised[1]! / raised[2]!).toBeCloseTo(-0.5, 5);
  });

  it("brings loud audio down to the target peak and leaves silence silent", () => {
    expect(Math.max(...raiseLevel(new Float32Array([1.4, -0.2])).map(Math.abs))).toBeCloseTo(TARGET_PEAK, 5);
    expect([...raiseLevel(new Float32Array([0, 0]))]).toEqual([0, 0]);
  });

  it("does not raise near-silence more than the gain limit (noise stays noise)", () => {
    const raised = raiseLevel(new Float32Array([0.001, -0.001]));
    expect(Math.abs(raised[0]!)).toBeLessThan(0.02);
  });
});

describe("encodeWav", () => {
  it("writes 16-bit mono PCM with a correct header", () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2]), 44_100);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
    expect(ascii(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(44_100);
    expect(view.getUint32(28, true)).toBe(88_200);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(12);
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 16384, -16384, 32767, -32767, 32767]);
  });
});
