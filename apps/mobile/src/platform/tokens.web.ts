// The web build (development and screenshots only): expo-secure-store has no web implementation, so the
// refresh token sits in sessionStorage, which ends with the browser tab.

import type { TokenStore } from "../api/client";

const KEY = "refresh-token";

const storage = (): Storage | null => (typeof sessionStorage === "undefined" ? null : sessionStorage);

export const tokenStore: TokenStore = {
  load: async () => storage()?.getItem(KEY) ?? null,
  save: async (token) => storage()?.setItem(KEY, token),
  clear: async () => storage()?.removeItem(KEY),
};
