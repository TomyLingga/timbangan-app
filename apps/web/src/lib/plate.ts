// Vehicle plates. The API keeps two forms: the plate as people write it
// (`plateDisplay`, with spaces) and a key without spaces for matching. The
// client check mirrors the API: 3 to 12 letters and digits once spaces are gone.

/** "zz 0001 cth" -> "ZZ0001CTH". */
export function plateKey(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

/** "  zz   0001 cth " -> "ZZ 0001 CTH". */
export function plateDisplay(input: string): string {
  return input.trim().replace(/\s+/g, " ").toUpperCase();
}

/** Message for an unacceptable plate, or null when it is fine. */
export function plateError(input: string): string | null {
  const key = plateKey(input);
  if (!key) return "Isi nomor plat.";
  if (!/^[A-Z0-9]+$/.test(key)) return "Plat hanya boleh berisi huruf, angka, dan spasi.";
  if (key.length < 3 || key.length > 12) return "Plat terdiri dari 3 sampai 12 huruf dan angka.";
  return null;
}
