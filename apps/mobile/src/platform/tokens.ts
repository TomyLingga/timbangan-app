// The refresh token on the phone: expo-secure-store (Android Keystore). The web build uses tokens.web.ts.

import * as SecureStore from "expo-secure-store";
import type { TokenStore } from "../api/client";

const KEY = "refresh-token";

export const tokenStore: TokenStore = {
  load: () => SecureStore.getItemAsync(KEY),
  save: (token) => SecureStore.setItemAsync(KEY, token),
  clear: () => SecureStore.deleteItemAsync(KEY),
};
