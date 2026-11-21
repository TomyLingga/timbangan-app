// Speaks the `speech` segments of an answer in order. All segments of a message are fetched at once, so the gaps
// stay short; they are played one after the other. A segment without audio (the API answered 204, or the fetch or
// the playback failed) is still shown, and the message gets one short tone. A new message drops what is left of
// the previous one once the segment being played ends. Never throws and never waits on the weighing.

export interface SpeechDeps {
  /** The audio of one segment, or null when there is none (204). */
  fetchAudio(text: string): Promise<ArrayBuffer | null>;
  play(audio: ArrayBuffer): Promise<void>;
  tone(): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** The segment being spoken now; null when done. */
  onSpeaking(text: string | null): void;
  gapMs?: number;
}

export interface SpeechQueue {
  say(segments: string[]): void;
  /** Resolves when nothing is being spoken. */
  whenIdle(): Promise<void>;
}

export function createSpeechQueue(deps: SpeechDeps): SpeechQueue {
  const gapMs = deps.gapMs ?? 250;
  let generation = 0;
  let running: Promise<void> = Promise.resolve();

  const quietly = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch {
      return fallback;
    }
  };

  async function speak(segments: string[], audios: Promise<ArrayBuffer | null>[], mine: number): Promise<void> {
    let toned = false;
    for (let index = 0; index < segments.length; index++) {
      if (mine !== generation) return;
      if (index > 0) await quietly(() => deps.sleep(gapMs), undefined);
      if (mine !== generation) return;
      deps.onSpeaking(segments[index] ?? null);
      const audio = await (audios[index] ?? Promise.resolve(null));
      const played = audio ? await quietly(async () => (await deps.play(audio), true), false) : false;
      if (!played && !toned) {
        toned = true;
        await quietly(() => deps.tone(), undefined);
      }
    }
    if (mine === generation) deps.onSpeaking(null);
  }

  return {
    say(segments: string[]) {
      if (segments.length === 0) return;
      const mine = ++generation;
      const audios = segments.map((text) => quietly(() => deps.fetchAudio(text), null));
      running = running.then(() => speak(segments, audios, mine));
    },
    whenIdle: () => running,
  };
}
