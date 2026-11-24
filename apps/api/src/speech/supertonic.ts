// Supertonic 3 (int8 export for sherpa-onnx) through the sherpa-onnx-node addon, in this process, on the CPU.
// The model is loaded once, on the first synthesis (the warm-up at start does that in the background); loading
// and synthesis run on the addon's worker threads, not on the event loop. Output: 16-bit mono WAV at the model's
// rate (44.1 kHz), raised to a fixed peak because the model speaks quietly.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { TTS_VOICES, type TtsConfig } from "../config.js";
import type { SpeechEngine } from "./engine.js";
import { encodeWav, raiseLevel } from "./wav.js";

/** The seven files of the model folder, by the name sherpa-onnx gives each part. */
export const SUPERTONIC_FILES = {
  durationPredictor: "duration_predictor.int8.onnx",
  textEncoder: "text_encoder.int8.onnx",
  vectorEstimator: "vector_estimator.int8.onnx",
  vocoder: "vocoder.int8.onnx",
  ttsJson: "tts.json",
  unicodeIndexer: "unicode_indexer.bin",
  voiceStyle: "voice.bin",
} as const;

/** Denoising steps per sentence; the samples the owner chose were made with 8. */
const NUM_STEPS = 8;

/** The part of the sherpa-onnx-node API used here (the package ships no TypeScript types). */
interface GeneratedAudio {
  samples: Float32Array;
  sampleRate: number;
}
interface OfflineTts {
  readonly sampleRate: number;
  readonly numSpeakers: number;
  generateAsync(request: { text: string; generationConfig: object }): Promise<GeneratedAudio>;
}
interface SherpaOnnx {
  OfflineTts: { createAsync(config: object): Promise<OfflineTts> };
  GenerationConfig: new (options: { sid: number; speed: number; numSteps: number; extra: Record<string, string> }) => object;
}

type SupertonicConfig = Extract<TtsConfig, { engine: "supertonic" }>;

export class SupertonicEngine implements SpeechEngine {
  readonly name: string;
  private readonly sid: number;
  private model: Promise<{ sherpa: SherpaOnnx; tts: OfflineTts }> | null = null;

  constructor(private readonly config: SupertonicConfig) {
    this.sid = TTS_VOICES.indexOf(config.voice);
    this.name = `supertonic3-${config.voice}-${config.speed.toFixed(2)}`;
  }

  /** Loads the model once; a failed load is tried again on the next synthesis. */
  load(): Promise<{ sherpa: SherpaOnnx; tts: OfflineTts }> {
    this.model ??= (async () => {
      const sherpa = createRequire(import.meta.url)("sherpa-onnx-node") as SherpaOnnx;
      const file = (name: string) => join(this.config.modelDir, name);
      const supertonic = Object.fromEntries(Object.entries(SUPERTONIC_FILES).map(([part, name]) => [part, file(name)]));
      const tts = await sherpa.OfflineTts.createAsync({
        model: { supertonic, debug: false, numThreads: this.config.threads, provider: "cpu" },
        maxNumSentences: 1,
      });
      return { sherpa, tts };
    })();
    this.model.catch(() => (this.model = null));
    return this.model;
  }

  async synthesize(spoken: string): Promise<Uint8Array> {
    const { sherpa, tts } = await this.load();
    const generationConfig = new sherpa.GenerationConfig({ sid: this.sid, speed: this.config.speed, numSteps: NUM_STEPS, extra: { lang: "id" } });
    const audio = await tts.generateAsync({ text: spoken, generationConfig });
    if (!audio.samples || audio.samples.length === 0) throw new Error("Supertonic made no audio");
    return encodeWav(raiseLevel(audio.samples), audio.sampleRate);
  }
}

/** Checks the model folder at start-up, so a missing file stops the service with its name, not the first truck. */
export function createSupertonicEngine(config: SupertonicConfig): SupertonicEngine {
  const missing = Object.values(SUPERTONIC_FILES).filter((name) => !existsSync(join(config.modelDir, name)));
  if (missing.length > 0) throw new Error(`TTS_MODEL_DIR ${config.modelDir} is missing the Supertonic 3 model file(s): ${missing.join(", ")}`);
  return new SupertonicEngine(config);
}
