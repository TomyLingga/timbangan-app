// The weight in the text lines a scale indicator sends. As in the program this replaces, the weight is the first
// token after the marker "99 "; only its digits are kept. Lines without the marker or without a number are noise
// and give nothing (the old program showed 0 for them; here they are skipped so noise cannot restart the
// stability count). Pure functions only.

const MARKER = "99 ";

/** The weight in whole kilograms in one line, or null when the line carries none. */
export function parseFrameLine(line: string): number | null {
  const clean = line.replace(/\u0000/g, "").trim();
  const at = clean.indexOf(MARKER);
  if (at < 0) return null;
  const token = clean.slice(at + MARKER.length).trim().split(/\s+/)[0] ?? "";
  const digits = token.replace(/[^0-9]/g, "");
  if (digits === "") return null;
  const value = Number.parseInt(digits, 10);
  return token.startsWith("-") ? -value : value;
}

export interface FrameParser {
  /** Adds received text and returns the weights of the lines it completed, in order. */
  push(chunk: string): number[];
}

/** Collects text across chunks and reads each complete line (CR, LF or CRLF). */
export function createFrameParser(options: { maxLineLength?: number } = {}): FrameParser {
  const maxLineLength = options.maxLineLength ?? 1024;
  let buffer = "";
  return {
    push(chunk: string): number[] {
      buffer += chunk;
      const lines = buffer.split(/\r\n|\r|\n/);
      buffer = lines.pop() ?? "";
      // a line end never came: the stream is not what we expect, start clean
      if (buffer.length > maxLineLength) buffer = "";
      const weights: number[] = [];
      for (const line of lines) {
        const weight = parseFrameLine(line);
        if (weight !== null) weights.push(weight);
      }
      return weights;
    },
  };
}
