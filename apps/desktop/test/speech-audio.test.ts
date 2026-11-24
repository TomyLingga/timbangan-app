import { describe, expect, it } from "vitest";
import { SPEECH_TEXT_MAX, speechAudioFor } from "../src/main/speech";

function fakeApi() {
  const asked: string[] = [];
  const api = {
    speechAudio: async (text: string) => {
      asked.push(text);
      return new TextEncoder().encode(text).buffer as ArrayBuffer;
    },
  };
  return { api, asked };
}

describe("speech audio for the window", () => {
  it("asks the API for one segment and hands back its audio", async () => {
    const { api, asked } = fakeApi();
    const audio = await speechAudioFor(api, "Kartu tidak dikenal.");
    expect(asked).toEqual(["Kartu tidak dikenal."]);
    expect(new TextDecoder().decode(audio as ArrayBuffer)).toBe("Kartu tidak dikenal.");
  });

  it("takes a text of exactly the limit", async () => {
    const { api, asked } = fakeApi();
    await speechAudioFor(api, "a".repeat(SPEECH_TEXT_MAX));
    expect(asked).toHaveLength(1);
  });

  it("gives null without asking the API for a text that is not one segment", async () => {
    const { api, asked } = fakeApi();
    for (const text of [undefined, null, 42, ["Kartu"], "", "   ", "a".repeat(SPEECH_TEXT_MAX + 1)]) {
      expect(await speechAudioFor(api, text)).toBeNull();
    }
    expect(asked).toEqual([]);
  });

  it("gives null while there is no API client", async () => {
    expect(await speechAudioFor(null, "Kartu tidak dikenal.")).toBeNull();
  });

  it("passes on null when the API has no audio", async () => {
    expect(await speechAudioFor({ speechAudio: async () => null }, "Kartu tidak dikenal.")).toBeNull();
  });
});
