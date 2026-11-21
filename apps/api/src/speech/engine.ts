// The voice behind one interface, chosen with TTS_ENGINE. Only `off` exists so far: the speech route answers
// 204 and the weighbridge program shows the text. A real engine (an in-process model or an HTTP service) adds
// a case to `speechEngineFor`; the audio of each text is kept on disk per engine, so a sentence is made once.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TtsConfig } from "../config.js";
import { FIXED_SENTENCES } from "../weighing/messages.js";

export { FIXED_SENTENCES };

export interface SpeechEngine {
  /** Part of the cache path: audio of one engine (or voice) is never served for another. */
  readonly name: string;
  /** WAV audio of one sentence, or null when this engine makes no audio. */
  synthesize(text: string): Promise<Uint8Array | null>;
}

export const offEngine: SpeechEngine = { name: "off", synthesize: async () => null };

export function speechEngineFor(config: TtsConfig): SpeechEngine {
  switch (config.engine) {
    case "off":
      return offEngine;
  }
}

/** WAV files on disk, one per engine and text, named by the SHA-256 of the text. */
export class SpeechCache {
  constructor(readonly dir: string) {}

  pathFor(engineName: string, text: string): string {
    const safeName = engineName.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.dir, safeName, `${createHash("sha256").update(text, "utf8").digest("hex")}.wav`);
  }

  async read(engineName: string, text: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(this.pathFor(engineName, text)));
    } catch {
      return null;
    }
  }

  /** Written to a temporary name first, so a reader never sees half a file. */
  async write(engineName: string, text: string, audio: Uint8Array): Promise<void> {
    const path = this.pathFor(engineName, text);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, audio);
    await rename(temporary, path);
  }
}

/** The audio of a text: from the cache, or made by the engine and kept. Null when the engine makes none. */
export async function speak(engine: SpeechEngine, cache: SpeechCache, text: string): Promise<Uint8Array | null> {
  if (engine === offEngine) return null;
  const known = await cache.read(engine.name, text);
  if (known) return known;
  const audio = await engine.synthesize(text);
  if (audio) await cache.write(engine.name, text, audio);
  return audio;
}

/** Makes the audio of the fixed sentences that are not on disk yet; answers how many were made. */
export async function warmSpeechCache(engine: SpeechEngine, cache: SpeechCache, sentences: string[] = FIXED_SENTENCES): Promise<number> {
  if (engine === offEngine) return 0;
  let made = 0;
  for (const text of sentences) {
    if (await cache.read(engine.name, text)) continue;
    const audio = await engine.synthesize(text);
    if (!audio) continue;
    await cache.write(engine.name, text, audio);
    made++;
  }
  return made;
}
