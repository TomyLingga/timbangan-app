// Audio in the window: the speech queue plays WAV segments fetched by the main process, and a short built-in tone
// when a segment has no audio. Web Audio only; nothing is loaded from the network by the window itself.
import { createSpeechQueue, type SpeechQueue } from "../../shared/speech-queue";

let context: AudioContext | null = null;
const audio = () => (context ??= new AudioContext());

/** How long `resume()` may take. Chromium leaves it pending for good when the window may not start audio. */
const RESUME_LIMIT_MS = 2_000;
/** Time allowed after the end of a segment for its `ended` event before the segment is given up. */
const END_MARGIN_MS = 2_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The context, running. Throws when it does not start, so the queue moves on (and shows the text) instead of
 * waiting on that segment for ever.
 */
async function runningContext(): Promise<AudioContext> {
  const ctx = audio();
  if (ctx.state !== "running") await Promise.race([ctx.resume(), wait(RESUME_LIMIT_MS)]);
  if (ctx.state !== "running") throw new Error(`audio context is ${ctx.state}`);
  return ctx;
}

async function play(data: ArrayBuffer): Promise<void> {
  const ctx = await runningContext();
  const buffer = await ctx.decodeAudioData(data.slice(0));
  await new Promise<void>((resolve, reject) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const timer = setTimeout(() => {
      source.onended = null;
      source.stop();
      reject(new Error("speech segment did not end"));
    }, buffer.duration * 1000 + END_MARGIN_MS);
    source.onended = () => {
      clearTimeout(timer);
      resolve();
    };
    source.start();
  });
}

/** Two short soft beeps: there is text on screen to read. */
async function tone(): Promise<void> {
  const ctx = await runningContext();
  const start = ctx.currentTime + 0.02;
  for (const [offset, frequency] of [
    [0, 880],
    [0.18, 660],
  ] as const) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start + offset);
    gain.gain.linearRampToValueAtTime(0.18, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.15);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.16);
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}

export function createSpeaker(onSpeaking: (text: string | null) => void): SpeechQueue {
  return createSpeechQueue({
    fetchAudio: (text) => window.desktop.speechAudio(text),
    play,
    tone,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onSpeaking,
    gapMs: 220,
  });
}
