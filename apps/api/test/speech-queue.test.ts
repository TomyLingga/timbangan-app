// The speaker between the routes and a voice engine: one synthesis at a time, identical texts share one job,
// audio kept on disk with a size cap, prefetch and warm-up in the background, failures answered as "no audio".
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { offEngine, type SpeechEngine, SpeechCache, Speaker } from "../src/speech/engine.js";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const tempFolder = async () => {
  const folder = await mkdtemp(join(tmpdir(), "timbangan-tts-q-"));
  folders.push(folder);
  return folder;
};

const bytes = (text: string) => new Uint8Array(Buffer.from(`RIFF${text}`));
const text = (audio: Uint8Array | null) => (audio ? Buffer.from(audio).toString("utf8") : null);

/** A fake engine whose syntheses finish only when the test says so; it records calls and overlap. */
function heldEngine() {
  const calls: string[] = [];
  const waiting = new Map<string, { resolve: (audio: Uint8Array | null) => void; reject: (error: Error) => void }>();
  let running = 0;
  let maxRunning = 0;
  const engine: SpeechEngine = {
    name: "held",
    synthesize: (spoken: string) => {
      calls.push(spoken);
      running++;
      maxRunning = Math.max(maxRunning, running);
      return new Promise<Uint8Array | null>((resolve, reject) => {
        waiting.set(spoken, {
          resolve: (audio) => (running--, resolve(audio)),
          reject: (error) => (running--, reject(error)),
        });
      });
    },
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  return {
    engine,
    calls,
    maxRunning: () => maxRunning,
    /** Waits until the synthesis of this spoken text has started. */
    async started(spoken: string) {
      for (let i = 0; i < 50 && !waiting.has(spoken); i++) await tick();
      if (!waiting.has(spoken)) throw new Error(`"${spoken}" did not start; calls: ${calls.join(" | ")}`);
    },
    /** Lets the synthesis of this spoken text finish, then gives the queue time to move on. */
    async finish(spoken: string, audio: Uint8Array | null = bytes(spoken)) {
      for (let i = 0; i < 50 && !waiting.has(spoken); i++) await tick();
      const job = waiting.get(spoken);
      if (!job) throw new Error(`no synthesis of "${spoken}" is running; calls: ${calls.join(" | ")}`);
      waiting.delete(spoken);
      job.resolve(audio);
      await tick();
    },
    async fail(spoken: string) {
      for (let i = 0; i < 50 && !waiting.has(spoken); i++) await tick();
      const job = waiting.get(spoken);
      if (!job) throw new Error(`no synthesis of "${spoken}" is running`);
      waiting.delete(spoken);
      job.reject(new Error("model broke"));
      await tick();
    },
  };
}

/** A fake engine that answers at once. */
function quickEngine(name = "quick") {
  const calls: string[] = [];
  const engine: SpeechEngine = { name, synthesize: async (spoken) => (calls.push(spoken), bytes(spoken)) };
  return { engine, calls };
}

describe("Speaker", () => {
  it("gives the engine the spoken form and keeps the audio on disk by engine and spoken text", async () => {
    const dir = await tempFolder();
    const { engine, calls } = quickEngine();
    const speaker = new Speaker(engine, new SpeechCache(dir));
    expect(text(await speaker.audio("Bruto 40.200 kilogram."))).toBe("RIFFBruto empat puluh ribu dua ratus kilogram.");
    expect(calls).toEqual(["Bruto empat puluh ribu dua ratus kilogram."]);
    // after a restart (a new speaker and cache on the same folder) the audio comes from disk
    const again = new Speaker(engine, new SpeechCache(dir));
    expect(text(await again.audio("Bruto 40.200 kilogram."))).toBe("RIFFBruto empat puluh ribu dua ratus kilogram.");
    // the same spoken text written another way is the same file
    expect(text(await again.audio("Bruto 40.200 kg."))).toBe("RIFFBruto empat puluh ribu dua ratus kilogram.");
    expect(calls).toHaveLength(1);
    expect(await readdir(join(dir, "quick"))).toHaveLength(1);
  });

  it("runs one synthesis at a time, in order", async () => {
    const held = heldEngine();
    const speaker = new Speaker(held.engine, new SpeechCache(await tempFolder()));
    const first = speaker.audio("Satu.");
    await held.started("Satu.");
    const second = speaker.audio("Dua.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // "Dua." waits while "Satu." is being made
    expect(held.calls).toEqual(["Satu."]);
    await held.finish("Satu.");
    expect(held.calls).toEqual(["Satu.", "Dua."]);
    await held.finish("Dua.");
    expect(text(await first)).toBe("RIFFSatu.");
    expect(text(await second)).toBe("RIFFDua.");
    expect(held.maxRunning()).toBe(1);
  });

  it("lets identical texts asked at the same time share one job", async () => {
    const held = heldEngine();
    const speaker = new Speaker(held.engine, new SpeechCache(await tempFolder()));
    const asked = [speaker.audio("Tunggu berat stabil."), speaker.audio("Tunggu berat stabil."), speaker.audio("Tunggu  berat stabil.")];
    await held.finish("Tunggu berat stabil.");
    expect((await Promise.all(asked)).map(text)).toEqual(Array(3).fill("RIFFTunggu berat stabil."));
    expect(held.calls).toEqual(["Tunggu berat stabil."]);
  });

  it("prefetches the segments of an answer, so the request a moment later joins the running job", async () => {
    const held = heldEngine();
    const speaker = new Speaker(held.engine, new SpeechCache(await tempFolder()));
    speaker.prefetch(["Timbang pertama berhasil.", "Bruto 40.200 kilogram."]);
    const asked = speaker.audio("Bruto 40.200 kilogram.");
    await held.finish("Timbang pertama berhasil.");
    await held.finish("Bruto empat puluh ribu dua ratus kilogram.");
    expect(text(await asked)).toBe("RIFFBruto empat puluh ribu dua ratus kilogram.");
    expect(held.calls).toEqual(["Timbang pertama berhasil.", "Bruto empat puluh ribu dua ratus kilogram."]);
    // cached now: prefetching again starts nothing
    speaker.prefetch(["Timbang pertama berhasil."]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held.calls).toHaveLength(2);
  });

  it("puts what a station asks for before the warm-up of the fixed sentences", async () => {
    const held = heldEngine();
    const speaker = new Speaker(held.engine, new SpeechCache(await tempFolder()));
    const warming = speaker.warm(["Satu.", "Dua.", "Tiga."]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const asked = speaker.audio("Plat B K.");
    await held.finish("Satu.");
    await held.finish("Plat be ka.");
    expect(text(await asked)).toBe("RIFFPlat be ka.");
    await held.finish("Dua.");
    await held.finish("Tiga.");
    expect(await warming).toBe(3);
    expect(held.calls).toEqual(["Satu.", "Plat be ka.", "Dua.", "Tiga."]);
  });

  it("moves a sentence waiting in the warm-up forward when a station asks for it", async () => {
    const held = heldEngine();
    const speaker = new Speaker(held.engine, new SpeechCache(await tempFolder()));
    const warming = speaker.warm(["Satu.", "Dua.", "Tiga."]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const asked = speaker.audio("Tiga.");
    await held.finish("Satu.");
    await held.finish("Tiga.");
    expect(text(await asked)).toBe("RIFFTiga.");
    await held.finish("Dua.");
    expect(await warming).toBe(3);
    expect(held.calls).toEqual(["Satu.", "Tiga.", "Dua."]);
  });

  it("answers no audio on a failure, logs it once per text, and keeps serving other texts", async () => {
    const held = heldEngine();
    const failures: string[] = [];
    const speaker = new Speaker(held.engine, new SpeechCache(await tempFolder()), (failed) => failures.push(failed));
    const broken = speaker.audio("Rusak.");
    await held.started("Rusak.");
    const fine = speaker.audio("Baik.");
    await held.fail("Rusak.");
    expect(await broken).toBeNull();
    await held.finish("Baik.");
    expect(text(await fine)).toBe("RIFFBaik.");
    // tried again on the next request, but not logged again
    const again = speaker.audio("Rusak.");
    await held.fail("Rusak.");
    expect(await again).toBeNull();
    expect(failures).toEqual(["Rusak."]);
    // a prefetch failure never throws
    speaker.prefetch(["Rusak."]);
    await held.fail("Rusak.");
    expect(failures).toEqual(["Rusak."]);
  });

  it("does not keep an empty answer of the engine", async () => {
    const held = heldEngine();
    const dir = await tempFolder();
    const speaker = new Speaker(held.engine, new SpeechCache(dir));
    const asked = speaker.audio("Kosong.");
    await held.finish("Kosong.", null);
    expect(await asked).toBeNull();
    await expect(readdir(join(dir, "held"))).rejects.toThrow();
  });

  it("with the off engine: no audio, nothing queued, nothing written", async () => {
    const dir = await tempFolder();
    const speaker = new Speaker(offEngine, new SpeechCache(dir));
    expect(await speaker.audio("Kartu tidak dikenal.")).toBeNull();
    speaker.prefetch(["Kartu tidak dikenal."]);
    expect(await speaker.warm(["Kartu tidak dikenal."])).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("SpeechCache size cap", () => {
  it("removes the least recently used files first once the folder grows past the cap", async () => {
    const dir = await tempFolder();
    const cache = new SpeechCache(dir, 100);
    const audio = new Uint8Array(40);
    await cache.write("v", "a", audio);
    await cache.write("v", "b", audio);
    // reading "a" makes it recent; "b" is now the oldest
    expect(await cache.read("v", "a")).not.toBeNull();
    await cache.write("v", "c", audio);
    expect(await cache.read("v", "b")).toBeNull();
    expect(await cache.read("v", "a")).not.toBeNull();
    expect(await cache.read("v", "c")).not.toBeNull();
    expect(await readdir(join(dir, "v"))).toHaveLength(2);
  });

  it("counts the files already on disk when it starts, oldest first", async () => {
    const dir = await tempFolder();
    const first = new SpeechCache(dir, 100);
    await first.write("v", "a", new Uint8Array(40));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.write("v", "b", new Uint8Array(40));
    // a stray temporary file from a crash is not audio and is removed
    await writeFile(join(dir, "v", "x.wav.1234.tmp"), "half");
    const restarted = new SpeechCache(dir, 100);
    await restarted.write("v", "c", new Uint8Array(40));
    expect(await restarted.read("v", "a")).toBeNull();
    expect(await restarted.read("v", "b")).not.toBeNull();
    expect((await readdir(join(dir, "v"))).sort()).toHaveLength(2);
  });
});
