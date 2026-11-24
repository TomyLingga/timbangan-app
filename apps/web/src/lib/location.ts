// A point on the map typed or picked by a person: the plant's location in Pengaturan GPS and the destination pin of a
// delivery order. Latitude and longitude are typed as text (a comma or a dot as decimal sign), or pasted together as
// one text the way Google Maps copies them ("3.5952, 98.6722").

export interface LatLon {
  lat: number;
  lon: number;
}

export interface LocationText {
  lat: string;
  lon: string;
}

/** A coordinate typed with a dot or a comma as decimal sign; null when it is not a number. */
export function coordinateFrom(text: string): number | null {
  const cleaned = text.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

const inRange = (point: LatLon) => Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;

// "3.5952, 98.6722", "3.5952,98.6722", "3.5952 98.6722", "3.5952; 98.6722": dot decimals, any separator
const DOT_PAIR = /^(-?\d+(?:\.\d+)?)(\s*[,;]\s*|\s+)(-?\d+(?:\.\d+)?)$/;
// "3,5952 98,6722", "3,5952; 98,6722": comma decimals, separated by a space or a semicolon
const COMMA_PAIR = /^(-?\d+(?:,\d+)?)\s*(?:;|\s)\s*(-?\d+(?:,\d+)?)$/;

/**
 * Latitude and longitude written as one text, as copied from Google Maps or a message: the two numbers in that order,
 * optionally in brackets. Null for anything else, including a single number or a pair outside the earth's ranges.
 */
export function parseCoordinatePair(text: string): LatLon | null {
  const trimmed = text
    .trim()
    .replace(/^[([]\s*/, "")
    .replace(/\s*[)\]]$/, "");
  let parts: [string, string] | null = null;
  const dotted = DOT_PAIR.exec(trimmed);
  if (dotted?.[1] && dotted[2] !== undefined && dotted[3]) {
    // "3,98" is one number with a decimal comma, not the pair 3 and 98: a bare comma needs dot decimals on both sides
    const bareComma = dotted[2] === ",";
    if (!bareComma || (dotted[1].includes(".") && dotted[3].includes("."))) parts = [dotted[1], dotted[3]];
  }
  const commas = parts ? null : COMMA_PAIR.exec(trimmed);
  if (commas?.[1] && commas[2]) parts = [commas[1], commas[2]];
  if (!parts) return null;
  const point = { lat: Number(parts[0].replace(",", ".")), lon: Number(parts[1].replace(",", ".")) };
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) && inRange(point) ? point : null;
}

/**
 * Checks a pin typed as two texts. Both empty: no pin. One empty, or a number outside its range: an error on that
 * field. The messages are the ones of the plant's location in Pengaturan GPS.
 */
export function checkLocation(values: LocationText): { errors: { lat?: string; lon?: string }; location: LatLon | null } {
  const errors: { lat?: string; lon?: string } = {};
  const latEmpty = values.lat.trim() === "";
  const lonEmpty = values.lon.trim() === "";
  if (latEmpty && lonEmpty) return { errors, location: null };
  const lat = coordinateFrom(values.lat);
  const lon = coordinateFrom(values.lon);
  if (latEmpty) errors.lat = "Isi lintang juga, atau kosongkan keduanya.";
  else if (lat === null || lat < -90 || lat > 90) errors.lat = "Lintang harus angka dari -90 sampai 90.";
  if (lonEmpty) errors.lon = "Isi bujur juga, atau kosongkan keduanya.";
  else if (lon === null || lon < -180 || lon > 180) errors.lon = "Bujur harus angka dari -180 sampai 180.";
  return { errors, location: errors.lat || errors.lon || lat === null || lon === null ? null : { lat, lon } };
}

/** A coordinate for a text field: at most 6 decimals (about 10 cm), dot decimal sign as maps apps take it. */
export const coordinateText = (value: number | null | undefined) => (value === null || value === undefined || !Number.isFinite(value) ? "" : String(Math.round(value * 1e6) / 1e6));

/** "-10.5, 85.25": the pin as people copy it into a maps app. */
export const locationText = (point: LatLon) => `${coordinateText(point.lat)}, ${coordinateText(point.lon)}`;

/** The place in Google Maps. Opened only when the user follows the link; nothing is sent before. */
export const googleMapsUrl = (point: LatLon) => `https://www.google.com/maps?q=${coordinateText(point.lat)},${coordinateText(point.lon)}`;
