// The window asks the main process for the audio of one speech segment (IPC `speech:audio`). The text comes from
// the window, so it is checked before it goes to the API.
import type { ApiClient } from "./api-client";

/** The API refuses longer texts (GET /api/weighbridge/speech). */
export const SPEECH_TEXT_MAX = 300;

/** The WAV of one segment, or null: no API client yet, a text that is not one segment, or no audio from the API. */
export async function speechAudioFor(api: Pick<ApiClient, "speechAudio"> | null, text: unknown): Promise<ArrayBuffer | null> {
  if (!api || typeof text !== "string" || !text.trim() || text.length > SPEECH_TEXT_MAX) return null;
  return api.speechAudio(text);
}
