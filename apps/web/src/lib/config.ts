// NEXT_PUBLIC_API_URL is inlined at build time. The fallback matches
// .env.example so `npm run dev` works against a local API without setup.
export const API_URL: string = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:3100").replace(/\/+$/, "");

export const SSO_START_URL = `${API_URL}/api/auth/sso/start`;

export const APP_NAME = "Registrasi Timbangan";
