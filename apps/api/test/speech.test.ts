// The text normaliser for the voice (pure), the sentence builder, and the speech route with its engine and
// disk cache.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXED_SENTENCES, type SpeechEngine, SpeechCache, warmSpeechCache } from "../src/speech/engine.js";
import { displayPlate, formatKg, normaliseSpeech, say, spellPlate } from "../src/weighing/speech.js";
import { testApp } from "./helpers/app.js";
import { seedWeighbridge } from "./helpers/weighing.js";

describe("normaliseSpeech", () => {
  it("writes units and abbreviations out and leaves weights as digits", () => {
    expect(normaliseSpeech("Bruto 40.200 kg.")).toBe("Bruto 40.200 kilogram.");
    expect(normaliseSpeech("Berikutnya: QC pass.")).toBe("Berikutnya: kiu si pass.");
    expect(normaliseSpeech("Nomor DO dan SPJ.")).toBe("Nomor di o dan es pe je.");
    expect(normaliseSpeech("Toleransi 0,2%.")).toBe("Toleransi 0,2 persen.");
    expect(normaliseSpeech("Buka  PIN   stasiun .")).toBe("Buka pin stasiun.");
    // only whole words: "kgx" and "QCA" stay
    expect(normaliseSpeech("kgx QCA")).toBe("kgx QCA");
    expect(normaliseSpeech("Netto 31.001 KG")).toBe("Netto 31.001 kilogram");
  });

  it("spells a plate letter by letter and digit by digit, whatever its spacing", () => {
    expect(spellPlate("BK 8790 VB")).toBe("B K delapan tujuh sembilan nol V B");
    expect(spellPlate("bk8790vb")).toBe("B K delapan tujuh sembilan nol V B");
    expect(spellPlate("B 1234 XYZ")).toBe("B satu dua tiga empat X Y Z");
  });

  it("shows plates and weights the way the plant writes them", () => {
    expect(displayPlate("BK8790VB")).toBe("BK 8790 VB");
    expect(displayPlate("bk 8790  vb")).toBe("BK 8790 VB");
    expect(formatKg(40_200)).toBe("40.200");
    expect(formatKg(1_234_567)).toBe("1.234.567");
    expect(formatKg(999)).toBe("999");
    expect(formatKg(-1_500)).toBe("-1.500");
  });
});

describe("say", () => {
  it("keeps every sentence a segment of its own: fixed sentences apart from those with a plate or a weight", () => {
    const spoken = say("Timbang pertama berhasil.", ["Plat ", { plate: "BK8790VB" }, "."], ["Bruto ", { kg: 40_200 }, "."], "Berikutnya: QC pass.");
    expect(spoken).toEqual({
      message: "Timbang pertama berhasil. Plat BK 8790 VB. Bruto 40.200 kg. Berikutnya: QC pass.",
      speech: ["Timbang pertama berhasil.", "Plat B K delapan tujuh sembilan nol V B.", "Bruto 40.200 kilogram.", "Berikutnya: kiu si pass."],
    });
  });

  it("lists the fixed sentences once, each already normalised", () => {
    expect(FIXED_SENTENCES).toContain("Timbang pertama berhasil.");
    expect(FIXED_SENTENCES).toContain("Mohon tunggu keputusan atasan.");
    expect(new Set(FIXED_SENTENCES).size).toBe(FIXED_SENTENCES.length);
    for (const sentence of FIXED_SENTENCES) {
      expect(normaliseSpeech(sentence)).toBe(sentence);
      expect(sentence).not.toMatch(/[0-9]/);
    }
  });
});

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
const tempFolder = async () => {
  const folder = await mkdtemp(join(tmpdir(), "timbangan-tts-"));
  folders.push(folder);
  return folder;
};

/** A made-up engine that answers a tiny WAV-like buffer and counts its calls. */
function fakeEngine(): SpeechEngine & { calls: string[] } {
  const calls: string[] = [];
  return { name: "fake", calls, synthesize: async (text: string) => (calls.push(text), new Uint8Array(Buffer.from(`RIFF${text}`))) };
}

describe("GET /api/weighbridge/speech", () => {
  it("answers 204 with the off engine, so the program shows the text only", async () => {
    const { app, database, config } = await testApp();
    expect(config.tts).toEqual({ engine: "off", cacheDir: ".data/tts-cache" });
    const { key } = await seedWeighbridge(database, { code: "WB-S", directions: ["IN"] });
    const response = await app.inject({ method: "GET", url: `/api/weighbridge/speech?text=${encodeURIComponent("Timbang pertama berhasil.")}`, headers: { "x-station-key": key } });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect((await app.inject({ method: "GET", url: "/api/weighbridge/speech?text=x" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/weighbridge/speech?text=", headers: { "x-station-key": key } })).statusCode).toBe(400);
  });

  it("with an engine: answers WAV and keeps it on disk by engine and text, so the engine runs once per text", async () => {
    const cacheDir = await tempFolder();
    const engine = fakeEngine();
    const { app, database } = await testApp({ TTS_CACHE_DIR: cacheDir }, { speechEngine: engine });
    const { key } = await seedWeighbridge(database, { code: "WB-S", directions: ["IN"] });
    const ask = (text: string) => app.inject({ method: "GET", url: `/api/weighbridge/speech?text=${encodeURIComponent(text)}`, headers: { "x-station-key": key } });
    const first = await ask("Bruto 40.200 kilogram.");
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("audio/wav");
    // the engine is given the spoken form; the route takes the readable segment
    expect(first.body).toBe("RIFFBruto empat puluh ribu dua ratus kilogram.");
    expect((await ask("Bruto 40.200 kilogram.")).body).toBe("RIFFBruto empat puluh ribu dua ratus kilogram.");
    expect(engine.calls).toEqual(["Bruto empat puluh ribu dua ratus kilogram."]);
    expect(await readdir(join(cacheDir, "fake"))).toHaveLength(1);
  });

  it("answers 204 when the engine fails, and the weighbridge answer itself is unaffected", async () => {
    const engine: SpeechEngine = { name: "broken", synthesize: async () => Promise.reject(new Error("model broke")) };
    const { app, database } = await testApp({ TTS_CACHE_DIR: await tempFolder() }, { speechEngine: engine });
    const { key } = await seedWeighbridge(database, { code: "WB-S", directions: ["IN"] });
    const card = await app.inject({ method: "GET", url: "/api/weighbridge/card/0000", headers: { "x-station-key": key } });
    expect(card.statusCode).toBe(404);
    expect(card.json().error.speech).toEqual(["Kartu tidak dikenal."]);
    const audio = await app.inject({ method: "GET", url: `/api/weighbridge/speech?text=${encodeURIComponent("Kartu tidak dikenal.")}`, headers: { "x-station-key": key } });
    expect(audio.statusCode).toBe(204);
  });

  it("starts making the audio of every weighbridge answer's segments right away (errors included)", async () => {
    const engine = fakeEngine();
    const { app, database } = await testApp({ TTS_CACHE_DIR: await tempFolder() }, { speechEngine: engine });
    const { key } = await seedWeighbridge(database, { code: "WB-S", directions: ["IN"] });
    await app.inject({ method: "GET", url: "/api/weighbridge/card/0000", headers: { "x-station-key": key } });
    await app.inject({ method: "GET", url: "/api/weighbridge/card/0000" });
    // a route outside the weighbridge does not
    await app.inject({ method: "GET", url: "/api/health" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.calls).toEqual(["Kartu tidak dikenal.", "Kunci stasiun tidak valid."]);
  });
});

describe("SpeechCache and warm-up", () => {
  it("makes the fixed sentences once at start and skips those already on disk", async () => {
    const engine = fakeEngine();
    const cache = new SpeechCache(await tempFolder());
    expect(await warmSpeechCache(engine, cache)).toBe(FIXED_SENTENCES.length);
    expect(await warmSpeechCache(engine, cache)).toBe(0);
    expect(engine.calls).toHaveLength(FIXED_SENTENCES.length);
    // a different engine has its own files
    expect(cache.pathFor("other", "Halo.")).not.toBe(cache.pathFor("fake", "Halo."));
  });
});
