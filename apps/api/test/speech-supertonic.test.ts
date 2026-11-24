// Settings of the Supertonic engine, its start-up check, and one opt-in run of the real model:
// set TTS_MODEL_DIR in the environment of the test run (not in .env) to the folder with the seven model files.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { SpeechCache, Speaker, speechEngineFor } from "../src/speech/engine.js";
import { SUPERTONIC_FILES, SupertonicEngine } from "../src/speech/supertonic.js";

const base = { DATABASE_URL: "pglite://memory", JWT_SECRET: "x".repeat(32) };

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const tempFolder = async () => {
  const folder = await mkdtemp(join(tmpdir(), "timbangan-tts-s-"));
  folders.push(folder);
  return folder;
};

describe("TTS settings", () => {
  it("defaults to off; supertonic needs TTS_MODEL_DIR and defaults to voice F2, speed 1, 4 threads", () => {
    expect(loadConfig(base).tts).toEqual({ engine: "off", cacheDir: ".data/tts-cache" });
    expect(() => loadConfig({ ...base, TTS_ENGINE: "supertonic" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, TTS_ENGINE: "supertonic" })).toThrow(/TTS_MODEL_DIR/);
    expect(loadConfig({ ...base, TTS_ENGINE: "supertonic", TTS_MODEL_DIR: "m" }).tts).toEqual({
      engine: "supertonic",
      cacheDir: ".data/tts-cache",
      modelDir: "m",
      voice: "F2",
      speed: 1,
      threads: 4,
    });
    expect(loadConfig({ ...base, TTS_ENGINE: "supertonic", TTS_MODEL_DIR: "m", TTS_VOICE: "M3", TTS_SPEED: "1.1", TTS_THREADS: "2" }).tts).toMatchObject({ voice: "M3", speed: 1.1, threads: 2 });
    expect(() => loadConfig({ ...base, TTS_ENGINE: "espeak" })).toThrow(/TTS_ENGINE/);
    expect(() => loadConfig({ ...base, TTS_ENGINE: "supertonic", TTS_MODEL_DIR: "m", TTS_VOICE: "F9" })).toThrow(/TTS_VOICE/);
    expect(() => loadConfig({ ...base, TTS_ENGINE: "supertonic", TTS_MODEL_DIR: "m", TTS_SPEED: "3" })).toThrow(/TTS_SPEED/);
  });

  it("stops at start-up naming the model files that are missing", async () => {
    const dir = await tempFolder();
    await writeFile(join(dir, "tts.json"), "{}");
    const config = loadConfig({ ...base, TTS_ENGINE: "supertonic", TTS_MODEL_DIR: dir });
    expect(() => speechEngineFor(config.tts)).toThrow(/vocoder\.int8\.onnx/);
    expect(() => speechEngineFor(config.tts)).not.toThrow(/tts\.json/);
  });

  it("names the cache folder after voice and speed, so another voice never gets this one's audio", async () => {
    const dir = await tempFolder();
    for (const name of Object.values(SUPERTONIC_FILES)) await writeFile(join(dir, name), "");
    const engine = speechEngineFor(loadConfig({ ...base, TTS_ENGINE: "supertonic", TTS_MODEL_DIR: dir }).tts);
    expect(engine.name).toBe("supertonic3-F2-1.00");
    expect(speechEngineFor(loadConfig({ ...base, TTS_ENGINE: "supertonic", TTS_MODEL_DIR: dir, TTS_VOICE: "M1", TTS_SPEED: "0.9" }).tts).name).toBe("supertonic3-M1-0.90");
  });
});

/** Sample rate, duration and level of a 16-bit mono WAV. */
function inspectWav(wav: Uint8Array) {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const sampleRate = view.getUint32(24, true);
  const samples = view.getUint32(40, true) / 2;
  let peak = 0;
  let sumSquares = 0;
  for (let i = 0; i < samples; i++) {
    const value = view.getInt16(44 + i * 2, true) / 32767;
    peak = Math.max(peak, Math.abs(value));
    sumSquares += value * value;
  }
  return { sampleRate, channels: view.getUint16(22, true), bits: view.getUint16(34, true), seconds: samples / sampleRate, peak, rms: Math.sqrt(sumSquares / samples) };
}

const modelDir = process.env.TTS_MODEL_DIR;

describe.skipIf(!modelDir)("Supertonic 3, real model (opt-in: TTS_MODEL_DIR)", () => {
  it("speaks weighbridge sentences at 44.1 kHz, not silent, and a repeat comes from the cache", { timeout: 180_000 }, async () => {
    const config = loadConfig({ ...base, TTS_ENGINE: "supertonic", TTS_MODEL_DIR: modelDir });
    const engine = speechEngineFor(config.tts) as SupertonicEngine;
    const speaker = new Speaker(engine, new SpeechCache(await tempFolder()));
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    const timed = async (text: string) => {
      const started = performance.now();
      const audio = await speaker.audio(text);
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      return { audio, ms: Math.round(performance.now() - started) };
    };
    const sentences = ["Plat B K delapan tujuh sembilan nol V B.", "Timbang pertama berhasil.", "Bruto 40.200 kilogram.", "Mohon tunggu keputusan atasan."];
    const rows = [];
    for (const text of sentences) {
      const { audio, ms } = await timed(text);
      expect(audio).not.toBeNull();
      const wav = inspectWav(audio as Uint8Array);
      expect(wav).toMatchObject({ sampleRate: 44_100, channels: 1, bits: 16 });
      expect(wav.seconds).toBeGreaterThan(0.5);
      expect(wav.peak).toBeGreaterThan(0.5);
      expect(wav.rms).toBeGreaterThan(0.02);
      rows.push({ text, ms, seconds: Number(wav.seconds.toFixed(2)), peak: Number(wav.peak.toFixed(3)), rms: Number(wav.rms.toFixed(3)) });
    }
    const repeat = await timed(sentences[2] as string);
    expect(repeat.audio).not.toBeNull();
    expect(repeat.ms).toBeLessThan(200);
    console.log(JSON.stringify({ rows, cachedRepeatMs: repeat.ms, rssBeforeMb: Math.round(rssBefore / 1e6), rssPeakMb: Math.round(rssPeak / 1e6) }, null, 2));
  });
});
