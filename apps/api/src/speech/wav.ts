// The engine's float samples as a WAV file the weighbridge program can play. Pure.

/** Peak level after `raiseLevel`: about -1 dBFS, loud without clipping. */
export const TARGET_PEAK = 0.89;
/** Audio that is almost silent is not raised more than this, so noise is not made loud. */
const MAX_GAIN = 10;

/** The samples scaled so the loudest one reaches TARGET_PEAK (Supertonic speaks quietly). */
export function raiseLevel(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const value of samples) peak = Math.max(peak, Math.abs(value));
  if (peak === 0) return samples;
  const gain = Math.min(TARGET_PEAK / peak, MAX_GAIN);
  return samples.map((value) => value * gain);
}

/** 16-bit mono PCM WAV; samples outside -1..1 are clipped. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) wav[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, value < 0 ? -Math.round(-value * 32767) : Math.round(value * 32767), true);
  }
  return wav;
}
