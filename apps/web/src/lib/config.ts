// NEXT_PUBLIC_API_URL is inlined at build time. The fallback matches
// .env.example so `npm run dev` works against a local API without setup.
export const API_URL: string = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3100").replace(/\/+$/, "");

// The road map's tiles, also inlined at build time. Only the area on screen goes to the tile server, never a truck's
// position. The default is the public OpenStreetMap server, whose tiles must show its attribution.
export const MAP_TILES_URL: string = process.env.NEXT_PUBLIC_MAP_TILES_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
export const MAP_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>';

export const SSO_START_URL = `${API_URL}/api/auth/sso/start`;

export const APP_NAME = "Registrasi Timbangan";
