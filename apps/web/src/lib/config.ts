// NEXT_PUBLIC_API_URL is inlined at build time. The fallback matches
// .env.example so `npm run dev` works against a local API without setup.
export const API_URL: string = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3100").replace(/\/+$/, "");

// The road map's tiles, also inlined at build time. Only the area on screen goes to the tile server, never a truck's
// position. The default is the public OpenStreetMap server, whose tiles must show its attribution.
export const MAP_TILES_URL: string = process.env.NEXT_PUBLIC_MAP_TILES_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const MAP_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

// The scanner helper of the registration post: a small program on the post's own PC that drives the scanner and
// answers one page as a JPEG (src/lib/scanner.ts). The default is where the helper of the old application listens.
export const SCANNER_URL: string = (process.env.NEXT_PUBLIC_SCANNER_URL || "http://127.0.0.1:7879").replace(/\/+$/, "");

export const SSO_START_URL = `${API_URL}/api/auth/sso/start`;

export const APP_NAME = "Registrasi Timbangan";
