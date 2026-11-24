// The page of the speech check. It speaks through the program's own audio module (src/renderer/src/audio.ts),
// which fetches the audio over the real preload bridge and plays it with Web Audio through the speech queue.
// Web Audio is watched from outside (prototype wrappers), so the module runs unchanged. Nothing here clicks or
// types: the main process starts each round with executeJavaScript without a user gesture.
import { createSpeaker } from "../../src/renderer/src/audio";
import type { Mark, MarkKind, PageResult } from "./marks";

declare global {
  interface Window {
    speechCheck?: (rounds: string[][], timeoutMs: number) => Promise<PageResult>;
  }
}

const marks: Mark[] = [];
const contexts: AudioContext[] = [];
let round = 0;
let segments: string[] = [];
let current: number | null = null;

const mark = (kind: MarkKind, segment: number | null, value?: string | number) =>
  marks.push({ at: Math.round(performance.now() * 10) / 10, kind, round, segment, ...(value === undefined ? {} : { value }) });

const Original = window.AudioContext;
window.AudioContext = class extends Original {
  constructor(options?: AudioContextOptions) {
    super(options);
    contexts.push(this);
    mark("context", current, this.state);
    this.addEventListener("statechange", () => mark("state", current, this.state));
  }
};

const decode = BaseAudioContext.prototype.decodeAudioData;
BaseAudioContext.prototype.decodeAudioData = function (this: BaseAudioContext, data: ArrayBuffer) {
  const segment = current;
  const decoding = decode.call(this, data);
  decoding.then(
    (buffer) => mark("decoded", segment, Math.round(buffer.duration * 1000) / 1000),
    (error: unknown) => mark("decoded", segment, `failed: ${String(error)}`),
  );
  return decoding;
} as typeof decode;

const createBufferSource = BaseAudioContext.prototype.createBufferSource;
BaseAudioContext.prototype.createBufferSource = function (this: BaseAudioContext) {
  const source = createBufferSource.call(this);
  const segment = current;
  const start = source.start.bind(source);
  source.start = (...args: Parameters<AudioBufferSourceNode["start"]>) => {
    mark("start", segment);
    start(...args);
  };
  source.addEventListener("ended", () => mark("ended", segment));
  return source;
};

const createOscillator = BaseAudioContext.prototype.createOscillator;
BaseAudioContext.prototype.createOscillator = function (this: BaseAudioContext) {
  const oscillator = createOscillator.call(this);
  const segment = current;
  const start = oscillator.start.bind(oscillator);
  oscillator.start = (when?: number) => {
    mark("tone-start", segment);
    start(when);
  };
  oscillator.addEventListener("ended", () => mark("tone-end", segment));
  return oscillator;
};

const speaker = createSpeaker((text) => {
  current = text === null ? null : segments.indexOf(text);
  if (text !== null) mark("speaking", current);
});

window.speechCheck = async (rounds, timeoutMs) => {
  for (const [index, list] of rounds.entries()) {
    round = index;
    segments = list;
    speaker.say(list);
    const idle = await Promise.race([speaker.whenIdle().then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))]);
    mark(idle ? "idle" : "timeout", null);
    if (!idle) break;
  }
  return { marks, contextStates: contexts.map((context) => context.state), hasBeenActive: navigator.userActivation?.hasBeenActive ?? null };
};
