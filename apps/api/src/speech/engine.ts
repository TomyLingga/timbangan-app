// The voice behind one interface, chosen with TTS_ENGINE: `off` (the speech route answers 204 and the weighbridge
// program shows the text) or `supertonic` (Supertonic 3 through sherpa-onnx, in this process, on the CPU).
// A `Speaker` sits between the routes and the engine: it gives the engine the spoken form of a segment, runs one
// synthesis at a time, lets identical texts share one job, and keeps the audio on disk so a sentence is made once.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TtsConfig } from "../config.js";
import { FIXED_SENTENCES } from "../weighing/messages.js";
import { spokenForm } from "./spoken.js";
import { createSupertonicEngine } from "./supertonic.js";

export { FIXED_SENTENCES };

export interface SpeechEngine {
  /** Part of the cache path: audio of one engine, voice or speed is never served for another. */
  readonly name: string;
  /** WAV audio of one sentence already in its spoken form, or null when this engine makes no audio. */
  synthesize(spoken: string): Promise<Uint8Array | null>;
}

export const offEngine: SpeechEngine = { name: "off", synthesize: async () => null };

/** The engine TTS_ENGINE names. Throws at start-up when the model files are missing. */
export function speechEngineFor(config: TtsConfig): SpeechEngine {
  switch (config.engine) {
    case "off":
      return offEngine;
    case "supertonic":
      return createSupertonicEngine(config);
  }
}

/** Default size cap of the audio folder: about 6,000 sentences of 3 seconds. */
export const DEFAULT_CACHE_MAX_BYTES = 500 * 1024 * 1024;

/**
 * WAV files on disk, one per engine and spoken text, named by the SHA-256 of the text. When the folder grows past
 * `maxBytes`, the files used least recently are removed first (reading a file counts as using it).
 */
export class SpeechCache {
  /** Path to size, least recently used first. Built from the folder on first use. */
  private index: Map<string, number> | null = null;
  private loading: Promise<Map<string, number>> | null = null;
  private total = 0;

  constructor(
    readonly dir: string,
    readonly maxBytes: number = DEFAULT_CACHE_MAX_BYTES,
  ) {}

  pathFor(engineName: string, text: string): string {
    const safeName = engineName.replace(/[^A-Za-z0-9_.-]/g, "_");
    return join(this.dir, safeName, `${createHash("sha256").update(text, "utf8").digest("hex")}.wav`);
  }

  async read(engineName: string, text: string): Promise<Uint8Array | null> {
    const path = this.pathFor(engineName, text);
    let audio: Uint8Array;
    try {
      audio = new Uint8Array(await readFile(path));
    } catch {
      const index = await this.files();
      const size = index.get(path);
      if (size !== undefined) (index.delete(path), (this.total -= size));
      return null;
    }
    const index = await this.files();
    index.delete(path);
    index.set(path, audio.byteLength);
    const now = new Date();
    void utimes(path, now, now).catch(() => undefined);
    return audio;
  }

  /** Written to a temporary name first, so a reader never sees half a file. */
  async write(engineName: string, text: string, audio: Uint8Array): Promise<void> {
    const path = this.pathFor(engineName, text);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, audio);
    await rename(temporary, path);
    const index = await this.files();
    const before = index.get(path);
    if (before !== undefined) (index.delete(path), (this.total -= before));
    index.set(path, audio.byteLength);
    this.total += audio.byteLength;
    await this.evict(path);
  }

  private async evict(keep: string): Promise<void> {
    const index = await this.files();
    for (const [path, size] of [...index]) {
      if (this.total <= this.maxBytes) return;
      if (path === keep) continue;
      index.delete(path);
      this.total -= size;
      await unlink(path).catch(() => undefined);
    }
  }

  private files(): Promise<Map<string, number>> {
    if (this.index) return Promise.resolve(this.index);
    this.loading ??= this.scan().then((index) => (this.index = index));
    return this.loading;
  }

  /** The WAV files already in the folder, oldest first; leftovers of an interrupted write are removed. */
  private async scan(): Promise<Map<string, number>> {
    const found: { path: string; size: number; mtimeMs: number }[] = [];
    const engines = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    for (const engine of engines) {
      if (!engine.isDirectory()) continue;
      const folder = join(this.dir, engine.name);
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        const path = join(folder, name);
        if (name.endsWith(".tmp")) {
          await unlink(path).catch(() => undefined);
          continue;
        }
        if (!name.endsWith(".wav")) continue;
        const info = await stat(path).catch(() => null);
        if (info?.isFile()) found.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      }
    }
    found.sort((a, b) => a.mtimeMs - b.mtimeMs);
    this.total = found.reduce((sum, file) => sum + file.size, 0);
    return new Map(found.map((file) => [file.path, file.size]));
  }
}

interface Made {
  audio: Uint8Array | null;
  /** True when the engine made it now, false when it came from disk or failed. */
  made: boolean;
}

interface Job {
  key: string;
  text: string;
  spoken: string;
  /** "now": a station waits for it, or will in a moment (prefetch); "later": the warm-up. */
  priority: "now" | "later";
  /** False for jobs queued without looking at the disk first; they look when they start. */
  checked: boolean;
  promise: Promise<Made>;
  resolve: (made: Made) => void;
}

/** Called once per text whose synthesis failed. */
export type SpeechFailure = (text: string, error: unknown) => void;

export class Speaker {
  /** Queued and running jobs by cache path; identical texts join the same job. */
  private readonly jobs = new Map<string, Job>();
  private readonly urgent: Job[] = [];
  private readonly background: Job[] = [];
  private busy = false;
  private readonly failed = new Set<string>();

  constructor(
    readonly engine: SpeechEngine,
    readonly cache: SpeechCache,
    public onFailure: SpeechFailure = () => undefined,
  ) {}

  /** The audio of one readable segment: from disk, or made now. Null with the off engine or on a failure. */
  async audio(text: string): Promise<Uint8Array | null> {
    if (this.engine === offEngine) return null;
    const spoken = spokenForm(text);
    if (!spoken) return null;
    const known = await this.cache.read(this.engine.name, spoken);
    if (known) return known;
    return (await this.enqueue(text, spoken, "now", true).promise).audio;
  }

  /** Starts making the segments that are not on disk yet, in order, without waiting. Never throws. */
  prefetch(texts: string[]): void {
    if (this.engine === offEngine) return;
    for (const text of texts) {
      const spoken = spokenForm(text);
      if (spoken) this.enqueue(text, spoken, "now", false);
    }
  }

  /** Makes the sentences that are not on disk yet, after anything a station asks for; answers how many were made. */
  async warm(sentences: string[]): Promise<number> {
    if (this.engine === offEngine) return 0;
    const jobs = sentences.map((text) => spokenForm(text)).filter(Boolean).map((spoken) => this.enqueue(spoken, spoken, "later", false));
    const results = await Promise.all(jobs.map((job) => job.promise));
    return results.filter((result) => result.made).length;
  }

  private enqueue(text: string, spoken: string, priority: Job["priority"], checked: boolean): Job {
    const key = this.cache.pathFor(this.engine.name, spoken);
    const existing = this.jobs.get(key);
    if (existing) {
      const waiting = this.background.indexOf(existing);
      if (priority === "now" && waiting >= 0) {
        this.background.splice(waiting, 1);
        existing.priority = "now";
        this.urgent.push(existing);
      }
      return existing;
    }
    let resolve: (made: Made) => void = () => undefined;
    const promise = new Promise<Made>((done) => (resolve = done));
    const job: Job = { key, text, spoken, priority, checked, promise, resolve };
    this.jobs.set(key, job);
    (priority === "now" ? this.urgent : this.background).push(job);
    this.pump();
    return job;
  }

  private pump(): void {
    if (this.busy) return;
    const job = this.urgent.shift() ?? this.background.shift();
    if (!job) return;
    this.busy = true;
    void this.run(job).finally(() => {
      this.busy = false;
      this.pump();
    });
  }

  private async run(job: Job): Promise<void> {
    let result: Made = { audio: null, made: false };
    try {
      const known = job.checked ? null : await this.cache.read(this.engine.name, job.spoken);
      if (known) result = { audio: known, made: false };
      else {
        const audio = await this.engine.synthesize(job.spoken);
        result = { audio, made: audio !== null };
        if (audio) await this.cache.write(this.engine.name, job.spoken, audio).catch((error: unknown) => this.report(job.text, error));
      }
    } catch (error) {
      this.report(job.text, error);
    } finally {
      this.jobs.delete(job.key);
      job.resolve(result);
    }
  }

  private report(text: string, error: unknown): void {
    if (this.failed.has(text)) return;
    this.failed.add(text);
    try {
      this.onFailure(text, error);
    } catch {
      // a broken logger never breaks the voice
    }
  }
}

const speakers = new WeakMap<SpeechCache, WeakMap<SpeechEngine, Speaker>>();

/** The one speaker of this engine and cache (one queue per process); `onFailure`, when given, replaces the logger. */
export function speakerFor(engine: SpeechEngine, cache: SpeechCache, onFailure?: SpeechFailure): Speaker {
  let byEngine = speakers.get(cache);
  if (!byEngine) speakers.set(cache, (byEngine = new WeakMap()));
  let speaker = byEngine.get(engine);
  if (!speaker) byEngine.set(engine, (speaker = new Speaker(engine, cache)));
  if (onFailure) speaker.onFailure = onFailure;
  return speaker;
}

/** The audio of a readable segment: from the cache, or made by the engine and kept. Null when there is none. */
export const speak = (engine: SpeechEngine, cache: SpeechCache, text: string): Promise<Uint8Array | null> => speakerFor(engine, cache).audio(text);

/** Starts making the segments of an answer in the background, so the audio is ready when the program asks. */
export const prefetchSpeech = (engine: SpeechEngine, cache: SpeechCache, texts: string[]): void => speakerFor(engine, cache).prefetch(texts);

/** Makes the audio of the fixed sentences that are not on disk yet; answers how many were made. */
export const warmSpeechCache = (engine: SpeechEngine, cache: SpeechCache, sentences: string[] = FIXED_SENTENCES): Promise<number> =>
  speakerFor(engine, cache).warm(sentences);
