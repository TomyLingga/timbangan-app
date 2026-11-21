// Plates for display. The API decides whether the camera plate matches; the program only shows both side by side
// and marks them, using the same normalising as the API (letters and digits, upper case). Pure.

export type PlateComparison = "MATCH" | "DIFFERENT" | "NO_READ";

/** Letters and digits in upper case: "xx 9876-yz" becomes "XX9876YZ". */
export const normalisePlate = (text: string | null | undefined): string => (text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** "XX9876YZ" as printed: "XX 9876 YZ". A plate that already has spaces keeps them, tidied. */
export function displayPlate(text: string | null | undefined): string {
  const trimmed = (text ?? "").trim();
  if (trimmed === "") return "";
  if (/\s/.test(trimmed)) return trimmed.toUpperCase().replace(/\s+/g, " ");
  return normalisePlate(trimmed).replace(/([A-Z])(?=[0-9])|([0-9])(?=[A-Z])/g, "$1$2 ");
}

export function comparePlates(read: string | null | undefined, registered: string | null | undefined): PlateComparison {
  const camera = normalisePlate(read);
  if (camera === "") return "NO_READ";
  return camera === normalisePlate(registered) ? "MATCH" : "DIFFERENT";
}
