import { describe, expect, it } from "vitest";
import { createSpeechQueue } from "../src/shared/speech-queue";

/** Fake audio: a text with "missing" in it has no audio, "broken" fails to fetch, "badplay" fails to play. */
function setup(options: { gate?: Promise<void> } = {}) {
  const log: string[] = [];
  const queue = createSpeechQueue({
    gapMs: 200,
    fetchAudio: async (text) => {
      log.push(`fetch ${text}`);
      if (text.includes("broken")) throw new Error("network");
      if (text.includes("missing")) return null;
      return new TextEncoder().encode(text).buffer as ArrayBuffer;
    },
    play: async (audio) => {
      const text = new TextDecoder().decode(audio);
      log.push(`play ${text}`);
      if (options.gate && text === "first") await options.gate;
      if (text.includes("badplay")) throw new Error("decode");
    },
    tone: async () => {
      log.push("tone");
    },
    sleep: async (ms) => {
      log.push(`sleep ${ms}`);
    },
    onSpeaking: (text) => log.push(`show ${text ?? "-"}`),
  });
  return { queue, log };
}

describe("speech queue", () => {
  it("fetches every segment at once, then plays them in order with a short gap and shows each", async () => {
    const { queue, log } = setup();
    queue.say(["Timbang pertama berhasil.", "Bruto 41.500 kilogram."]);
    await queue.whenIdle();
    expect(log).toEqual([
      "fetch Timbang pertama berhasil.",
      "fetch Bruto 41.500 kilogram.",
      "show Timbang pertama berhasil.",
      "play Timbang pertama berhasil.",
      "sleep 200",
      "show Bruto 41.500 kilogram.",
      "play Bruto 41.500 kilogram.",
      "show -",
    ]);
  });

  it("shows the text and plays one short tone when audio is missing (204) or cannot be fetched or played", async () => {
    const { queue, log } = setup();
    queue.say(["missing one", "broken two", "badplay three", "ok four"]);
    await queue.whenIdle();
    expect(log.filter((line) => line === "tone")).toHaveLength(1);
    expect(log.filter((line) => line.startsWith("show "))).toEqual(["show missing one", "show broken two", "show badplay three", "show ok four", "show -"]);
    expect(log).toContain("play ok four");
  });

  it("drops what is left of the previous message when a new one comes, after the segment being played", async () => {
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { queue, log } = setup({ gate });
    queue.say(["first", "second"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    queue.say(["third"]);
    open();
    await queue.whenIdle();
    const played = log.filter((line) => line.startsWith("play "));
    expect(played).toEqual(["play first", "play third"]);
  });

  it("does nothing for an empty message and never throws", async () => {
    const { queue, log } = setup();
    queue.say([]);
    await expect(queue.whenIdle()).resolves.toBeUndefined();
    expect(log).toEqual([]);
  });
});
