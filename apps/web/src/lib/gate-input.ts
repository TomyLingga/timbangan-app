// Input at the registration post. A barcode reader and an RFID reader both
// type like a keyboard and end with Enter, so the text is cleaned the same way
// whether it was scanned or typed. The API normalises again; this only lets
// the screen refuse obvious mistakes without a round trip.

/** Letters of the SPJ token: digits and A to Z without I, L, O and U. */
const TOKEN_PATTERN = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const TOKEN_LENGTH = 12;

/** Upper case without spaces or dashes; I and L read as 1, O as 0 (they look alike on paper). */
export function normalizeSpjToken(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export function spjTokenError(token: string): string | null {
  if (!token) return "Scan barcode SPJ atau ketik kodenya.";
  if (token.length !== TOKEN_LENGTH) return "Kode SPJ terdiri dari 12 huruf dan angka. Periksa lagi kodenya.";
  if (!TOKEN_PATTERN.test(token)) return "Kode ini bukan kode SPJ. Periksa lagi kodenya.";
  return null;
}

/** Hexadecimal UID in upper case without separators ("0a:1b" -> "0A1B"). */
export function normalizeCardUid(input: string): string {
  return input.toUpperCase().replace(/[\s:-]+/g, "");
}

export function cardUidError(uid: string): string | null {
  if (!uid) return "Tempelkan kartu ke pembaca, atau ketik UID kartu.";
  if (!/^[0-9A-F]+$/.test(uid)) return "UID kartu hanya berisi angka 0 sampai 9 dan huruf A sampai F.";
  if (uid.length < 8 || uid.length > 20) return "UID kartu terdiri dari 8 sampai 20 karakter.";
  return null;
}
