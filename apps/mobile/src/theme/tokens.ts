// Colours of the web app (apps/web/src/app/globals.css), converted from oklch to hex: a near-black canvas with a
// teal tint and panels a step lighter for the dark theme, warm paper-white for the light theme. Mint is the
// active and OK colour, amber what needs attention, coral a refusal. Text never goes lighter than `muted`.

export interface Palette {
  background: string;
  surface: string;
  card: string;
  foreground: string;
  muted: string;
  border: string;
  lineStrong: string;
  input: string;
  primary: string;
  primaryFg: string;
  primaryInk: string;
  primarySubtle: string;
  signal: string;
  signalFg: string;
  signalInk: string;
  signalSubtle: string;
  danger: string;
  dangerSubtle: string;
  success: string;
  successSubtle: string;
  info: string;
  infoSubtle: string;
  fill: string;
}

export const dark: Palette = {
  background: "#091010",
  surface: "#0c1414",
  card: "#0f1717",
  foreground: "#eaf0ee",
  // brighter than the web's muted text: read outdoors, never small grey
  muted: "#b4c0bf",
  border: "#212b2b",
  lineStrong: "#323d3d",
  input: "#435050",
  primary: "#78dac0",
  primaryFg: "#041a18",
  primaryInk: "#7bddc4",
  primarySubtle: "#052d27",
  signal: "#f3bd5c",
  signalFg: "#251403",
  signalInk: "#f5c66d",
  signalSubtle: "#372508",
  danger: "#fc7a73",
  dangerSubtle: "#3c1715",
  success: "#75d78d",
  successSubtle: "#0d2814",
  info: "#80c7f8",
  infoSubtle: "#0e2433",
  fill: "#162020",
};

export const light: Palette = {
  background: "#f9f8f4",
  surface: "#f4f2ee",
  card: "#fefdfb",
  foreground: "#131d1d",
  muted: "#3f4c4d",
  border: "#e2dfda",
  lineStrong: "#cdcac3",
  input: "#899595",
  primary: "#0c7d6c",
  primaryFg: "#f9fdfc",
  primaryInk: "#006b5d",
  primarySubtle: "#d3f3eb",
  signal: "#eb9f2c",
  signalFg: "#301904",
  signalInk: "#8a4d00",
  signalSubtle: "#ffeccd",
  danger: "#be2323",
  dangerSubtle: "#ffe9e7",
  success: "#146d34",
  successSubtle: "#ddf7e1",
  info: "#176297",
  infoSubtle: "#e2f2ff",
  fill: "#efece8",
};

export const radius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 } as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
/** Gloves: nothing a person taps is smaller than this. */
export const TOUCH = 56;
export const fontSize = { small: 15, body: 17, label: 16, title: 22, big: 28, plate: 26 } as const;

export type ThemeMode = "system" | "dark" | "light";
