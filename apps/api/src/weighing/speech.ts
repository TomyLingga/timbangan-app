// Text for the weighbridge screen (`message`) and for the voice (`speech`), built from the same sentences.
// Each sentence is one speech segment: a fixed sentence ("Timbang pertama berhasil.") stays a segment of its own,
// so its audio can be made once and reused; a sentence with a plate or a weight is a segment that changes.
// Pure functions only.

/** A part of a sentence: plain text, a plate (spelled out when spoken) or a weight in kilograms. */
export type Piece = string | { plate: string } | { kg: number };
export type Sentence = Piece | Piece[];

export interface Spoken {
  message: string;
  speech: string[];
}

const DIGIT_WORDS = ["nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"];

/** Units and abbreviations the voice reads wrongly, written out. Matched as whole words, case as given. */
const SPOKEN_WORDS: [RegExp, string][] = [
  [/\bkg\b/gi, "kilogram"],
  [/\bQC\b/g, "kiu si"],
  [/\bDO\b/g, "di o"],
  [/\bSPJ\b/g, "es pe je"],
  [/\bBA\b/g, "berita acara"],
  [/\bPIN\b/g, "pin"],
  [/%/g, " persen"],
];

/** 40200 as "40.200": the thousands separator the plant reads. */
export function formatKg(value: number): string {
  const sign = value < 0 ? "-" : "";
  return sign + String(Math.abs(Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Letters and digits of a plate, upper case: "bk 8790-vb" becomes "BK8790VB". */
const plateCharacters = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "BK8790VB" as printed: "BK 8790 VB". A plate that already has spaces is kept as it is. */
export function displayPlate(text: string): string {
  if (/\s/.test(text.trim())) return text.trim().toUpperCase().replace(/\s+/g, " ");
  return plateCharacters(text).replace(/([A-Z])(?=[0-9])|([0-9])(?=[A-Z])/g, "$1$2 ");
}

/** A plate spelled letter by letter and digit by digit: "BK 8790 VB" becomes "B K delapan tujuh sembilan nol V B". */
export function spellPlate(text: string): string {
  return [...plateCharacters(text)].map((char) => (/[0-9]/.test(char) ? DIGIT_WORDS[Number(char)] : char)).join(" ");
}

/** Plain text as the voice should read it: units and abbreviations written out; numbers stay digits. */
export function normaliseSpeech(text: string): string {
  return writeOut(text).replace(/\s+/g, " ").replace(/\s+([.,:;?!])/g, "$1").trim();
}

function writeOut(text: string): string {
  let spoken = text;
  for (const [pattern, words] of SPOKEN_WORDS) spoken = spoken.replace(pattern, words);
  return spoken;
}

const pieces = (sentence: Sentence): Piece[] => (Array.isArray(sentence) ? sentence : [sentence]);
const join = (parts: string[]) => parts.join("").replace(/\s+/g, " ").trim();

function shown(piece: Piece): string {
  if (typeof piece === "string") return piece;
  if ("plate" in piece) return displayPlate(piece.plate);
  return `${formatKg(piece.kg)} kg`;
}

function spoken(piece: Piece): string {
  if (typeof piece === "string") return writeOut(piece);
  if ("plate" in piece) return spellPlate(piece.plate);
  return `${formatKg(piece.kg)} kilogram`;
}

/** Two answers' texts one after the other. */
export const joinSpoken = (...parts: Spoken[]): Spoken => ({ message: parts.map((part) => part.message).join(" "), speech: parts.flatMap((part) => part.speech) });

/** The message and speech segments of these sentences, in order. */
export function say(...sentences: Sentence[]): Spoken {
  const list = sentences.map(pieces).filter((parts) => parts.length > 0);
  return {
    message: list.map((parts) => join(parts.map(shown))).join(" "),
    speech: list.map((parts) => normaliseSpeech(join(parts.map(spoken)))),
  };
}
