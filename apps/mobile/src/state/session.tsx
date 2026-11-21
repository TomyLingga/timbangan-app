// The signed-in account. The refresh token survives app restarts (secure store); the account itself is cached
// so the app opens without signal and the send queue can go on once the network is back.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Platform } from "react-native";
import { type ApiClient, createApiClient, isApiError, SIGNED_OUT } from "../api/client";
import type { Account, MeResponse } from "../api/types";
import { tokenStore } from "../platform/tokens";

const ACCOUNT_KEY = "account-v1";

/** EXPO_PUBLIC_API_URL is put into the bundle when it is built. */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

type Status = "loading" | "signedOut" | "signedIn";

interface SessionValue {
  status: Status;
  user: Account | null;
  api: ApiClient;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Reloads the account (permissions may have changed). */
  reloadUser(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<Account | null>(null);
  const signedOutRef = useRef<() => void>(() => undefined);

  const api = useMemo(
    () => createApiClient({ baseUrl: API_URL, tokens: tokenStore, clientKind: Platform.OS === "ios" ? "ios" : "android", onSignedOut: () => signedOutRef.current() }),
    [],
  );

  const forget = useCallback(async () => {
    setUser(null);
    setStatus("signedOut");
    await AsyncStorage.removeItem(ACCOUNT_KEY).catch(() => undefined);
  }, []);
  signedOutRef.current = () => void forget();

  const reloadUser = useCallback(async () => {
    try {
      const me = await api.request<MeResponse>("/api/me");
      setUser(me.user);
      await AsyncStorage.setItem(ACCOUNT_KEY, JSON.stringify(me.user)).catch(() => undefined);
    } catch (error) {
      if (isApiError(error) && error.code === SIGNED_OUT) await forget();
      // without signal the cached account stays
    }
  }, [api, forget]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const token = await tokenStore.load().catch(() => null);
      if (!token) {
        if (alive) setStatus("signedOut");
        return;
      }
      const cached = await AsyncStorage.getItem(ACCOUNT_KEY).catch(() => null);
      if (cached && alive) {
        setUser(JSON.parse(cached) as Account);
        setStatus("signedIn");
        void reloadUser();
        return;
      }
      try {
        const me = await api.request<MeResponse>("/api/me");
        if (!alive) return;
        setUser(me.user);
        setStatus("signedIn");
        await AsyncStorage.setItem(ACCOUNT_KEY, JSON.stringify(me.user)).catch(() => undefined);
      } catch {
        if (alive) setStatus("signedOut");
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, reloadUser]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      user,
      api,
      async login(username, password) {
        const answer = await api.login(username, password);
        setUser(answer.user);
        setStatus("signedIn");
        await AsyncStorage.setItem(ACCOUNT_KEY, JSON.stringify(answer.user)).catch(() => undefined);
      },
      async logout() {
        await api.logout();
        await forget();
      },
      reloadUser,
    }),
    [status, user, api, forget, reloadUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
