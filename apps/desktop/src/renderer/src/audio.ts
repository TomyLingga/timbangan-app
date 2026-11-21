// Audio in the window: the speech queue plays WAV segments fetched by the main process, and a short built-in tone
// when a segment has no audio. Web Audio only; nothing is loaded from the network by the window itself.
import { createSpeechQueue, type SpeechQueue } from "../../shared/speech-queue";

let context: AudioContext | null = null;
const audio = () => (context ??= new AudioContext());

async function play(data: ArrayBuffer): Promise<void> {
  const ctx = audio();
  if (ctx.state === "suspended") await ctx.resume();
  const buffer = await ctx.decodeAudioData(data.slice(0));
  await new Promise<void>((resolve) => {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => resolve();
    source.start();
  });
}

/** Two short soft beeps: there is text on screen to read. */
async function tone(): Promise<void> {
  const ctx = audio();
  if (ctx.state === "suspended") await ctx.resume();
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
