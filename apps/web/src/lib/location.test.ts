import { describe, expect, it } from "vitest";

import { checkLocation, coordinateFrom, coordinateText, googleMapsUrl, locationText, parseCoordinatePair } from "@/lib/location";

describe("parseCoordinatePair", () => {
  it("reads the pair as Google Maps copies it, and the usual variations", () => {
    expect(parseCoordinatePair("-10.5952, 85.6722")).toEqual({ lat: -10.5952, lon: 85.6722 });
    expect(parseCoordinatePair("  -10.5952,85.6722 ")).toEqual({ lat: -10.5952, lon: 85.6722 });
    expect(parseCoordinatePair("-10.5952 85.6722")).toEqual({ lat: -10.5952, lon: 85.6722 });
    expect(parseCoordinatePair("-10.5952; 85.6722")).toEqual({ lat: -10.5952, lon: 85.6722 });
    expect(parseCoordinatePair("(-10.5952, 85.6722)")).toEqual({ lat: -10.5952, lon: 85.6722 });
    expect(parseCoordinatePair("-10,5952 85,6722")).toEqual({ lat: -10.5952, lon: 85.6722 });
    expect(parseCoordinatePair("-10,5952; 85,6722")).toEqual({ lat: -10.5952, lon: 85.6722 });
  });

  it("leaves a single number, a decimal comma and other text alone", () => {
    expect(parseCoordinatePair("-10.5952")).toBeNull();
    expect(parseCoordinatePair("3,98")).toBeNull();
    expect(parseCoordinatePair("Gudang Contoh")).toBeNull();
    expect(parseCoordinatePair("-10.5, 85.2, 7")).toBeNull();
    expect(parseCoordinatePair("")).toBeNull();
  });

  it("refuses a pair outside the earth's ranges", () => {
    expect(parseCoordinatePair("95.1, 85.2")).toBeNull();
    expect(parseCoordinatePair("-10.5, 185.2")).toBeNull();
    expect(parseCoordinatePair("-90, 180")).toEqual({ lat: -90, lon: 180 });
  });
});

describe("checkLocation", () => {
  it("gives no pin and no error when both fields are empty", () => {
    expect(checkLocation({ lat: " ", lon: "" })).toEqual({ errors: {}, location: null });
  });

  it("takes a comma or a dot as decimal sign", () => {
    expect(checkLocation({ lat: "-10,5", lon: "85.25" })).toEqual({ errors: {}, location: { lat: -10.5, lon: 85.25 } });
  });

  it("names the field that is missing or out of range", () => {
    expect(checkLocation({ lat: "-10.5", lon: "" })).toEqual({ errors: { lon: "Isi bujur juga, atau kosongkan keduanya." }, location: null });
    expect(checkLocation({ lat: "", lon: "85" })).toEqual({ errors: { lat: "Isi lintang juga, atau kosongkan keduanya." }, location: null });
    expect(checkLocation({ lat: "91", lon: "85" }).errors).toEqual({ lat: "Lintang harus angka dari -90 sampai 90." });
    expect(checkLocation({ lat: "10", lon: "timur" }).errors).toEqual({ lon: "Bujur harus angka dari -180 sampai 180." });
  });
});

describe("coordinate wording", () => {
  it("keeps at most six decimals and a dot", () => {
    expect(coordinateText(-10.123456789)).toBe("-10.123457");
    expect(coordinateText(null)).toBe("");
    expect(coordinateFrom("85,25")).toBe(85.25);
    expect(locationText({ lat: -10.5, lon: 85.25 })).toBe("-10.5, 85.25");
  });

  it("builds the Google Maps address of a point", () => {
    expect(googleMapsUrl({ lat: -10.5, lon: 85.25 })).toBe("https://www.google.com/maps?q=-10.5,85.25");
  });
});
