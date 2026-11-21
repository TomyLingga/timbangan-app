// The RFID reader types the card UID as keystrokes and ends with Enter. A card is a run of keys that each follow
// the previous one within a few milliseconds; a person typing is far slower and is ignored. Pure.

export const CARD_INPUT = { maxGapMs: 50, minLength: 8 } as const;

export interface CardInputState {
  buffer: string;
  lastAt: number | null;
}

export const initialCardInput = (): CardInputState => ({ buffer: "", lastAt: null });

/** The UID as the API stores it: upper case, without separators, 8 to 20 hexadecimal characters; else null. */
export function normaliseCardUid(text: string): string | null {
  const uid = text.toUpperCase().replace(/[\s:.-]/g, "");
  return /^[0-9A-F]{8,20}$/.test(uid) ? uid : null;
}

export function feedCardKey(state: CardInputState, key: string, now: number, maxGapMs: number = CARD_INPUT.maxGapMs): { state: CardInputState; card: string | null } {
  const inTime = state.lastAt !== null && now - state.lastAt <= maxGapMs;
  if (key === "Enter") {
    const card = inTime && state.buffer.length >= CARD_INPUT.minLength ? normaliseCardUid(state.buffer) : null;
    return { state: initialCardInput(), card };
  }
  // Shift, Tab and other named keys carry no character
  if (key.length !== 1) return { state, card: null };
  const buffer = inTime ? state.buffer + key : key;
  return { state: { buffer: buffer.slice(-64), lastAt: now }, card: null };
}
