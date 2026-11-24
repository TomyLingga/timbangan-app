// What the voice engine is given for one speech segment. The segments of an answer (`speech[]`) stay readable
// text ("Bruto 40.200 kilogram.", "Plat B K delapan V B."); this writes them the way they are spoken: numbers in
// Indonesian words, the letters of a spelled plate by their names, with a short pause between the characters of
// a plate, as in the sample the owner chose ("Truk be ka, delapan, tujuh, sembilan, nol, fe be."). Pure.
import { normaliseSpeech } from "../weighing/speech.js";

const UNITS = ["nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"];
const SCALES = ["", "ribu", "juta", "miliar", "triliun"];

const LETTER_NAMES: Record<string, string> = {
  A: "a", B: "be", C: "ce", D: "de", E: "e", F: "ef", G: "ge", H: "ha", I: "i", J: "je", K: "ka", L: "el", M: "em",
  N: "en", O: "o", P: "pe", Q: "ki", R: "er", S: "es", T: "te", U: "u", V: "fe", W: "we", X: "eks", Y: "ye", Z: "zet",
};

/** 1 to 999 in words; empty for 0. */
function below1000(n: number): string {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds === 1) words.push("seratus");
  else if (hundreds > 1) words.push(`${UNITS[hundreds]} ratus`);
  if (rest === 10) words.push("sepuluh");
  else if (rest === 11) words.push("sebelas");
  else if (rest > 11 && rest < 20) words.push(`${UNITS[rest - 10]} belas`);
  else if (rest >= 20) {
    words.push(`${UNITS[Math.floor(rest / 10)]} puluh`);
    if (rest % 10) words.push(UNITS[rest % 10] as string);
  } else if (rest > 0) words.push(UNITS[rest] as string);
  return words.join(" ");
}

/** A whole number from 0 up to below 10^15 in Indonesian words: 40200 is "empat puluh ribu dua ratus". */
export function numberWords(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1e15) throw new RangeError(`no words for ${value}`);
  if (value === 0) return "nol";
  const groups: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 1000)) groups.push(rest % 1000);
  const words: string[] = [];
  for (let scale = groups.length - 1; scale >= 0; scale--) {
    const group = groups[scale] ?? 0;
    if (group === 0) continue;
    if (scale === 1 && group === 1) words.push("seribu");
    else words.push(scale === 0 ? below1000(group) : `${below1000(group)} ${SCALES[scale]}`);
  }
  return words.join(" ");
}

const spellDigits = (digits: string) => [...digits].map((digit) => UNITS[Number(digit)]).join(" ");

/** "40.200", "1,22", "-1.500", "1000": dots group thousands, a comma starts the decimals. */
const NUMBER = /(?<![\w.,])(-?)(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?(?![\w]|[.,]\d)/g;

function numberSpoken(_match: string, minus: string, whole: string, decimals: string | undefined): string {
  const digits = whole.replace(/\./g, "");
  // very long digit strings (a number, not an amount) are read digit by digit
  const words = digits.length > 15 ? spellDigits(digits) : numberWords(Number(digits));
  return [minus ? "minus" : "", words, decimals ? `koma ${spellDigits(decimals)}` : ""].filter(Boolean).join(" ");
}

const PLATE_TOKEN = `(?:[A-Z]|${UNITS.join("|")})`;
/** A run of single capital letters and digit words, as `spellPlate` writes a plate. */
const PLATE_RUN = new RegExp(`(?<![\\w])${PLATE_TOKEN}(?:\\s+${PLATE_TOKEN})*(?![\\w])`, "g");

/** "B K delapan V B" becomes "be ka, delapan, fe be": letters together, each digit apart, a comma between. */
function plateSpoken(run: string): string {
  const tokens = run.split(/\s+/);
  // digit words without a letter are plain words ("Sisa dua kali."): left alone
  if (!tokens.some((token) => token in LETTER_NAMES)) return run;
  const groups: string[] = [];
  let letters: string[] = [];
  for (const token of tokens) {
    if (token in LETTER_NAMES) {
      letters.push(LETTER_NAMES[token] as string);
      continue;
    }
    if (letters.length) groups.push(letters.join(" "));
    letters = [];
    groups.push(token);
  }
  if (letters.length) groups.push(letters.join(" "));
  return groups.join(", ");
}

/** One readable speech segment written the way the voice must say it. */
export function spokenForm(segment: string): string {
  return normaliseSpeech(normaliseSpeech(segment).replace(NUMBER, numberSpoken).replace(PLATE_RUN, plateSpoken));
}
