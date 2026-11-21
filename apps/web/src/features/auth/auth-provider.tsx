"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { isApiError, SIGNED_OUT } from "@/lib/api-client";
import { api, onSignedOut } from "@/lib/session";
import { readSsoTicket, type SsoTicket } from "@/lib/sso-ticket";
import type { AuthResponse, User } from "@/lib/types";

export type AuthState =
  /** The page just loaded and the refresh call has not answered yet. */
  | { status: "loading" }
  | { status: "anonymous"; notice: "expired" | null }
  | { status: "authenticated"; user: User }
  /** Signed in, but the API answers 403 NO_ACCESS and gave no user to show. */
  | { status: "no-access" }
  /** The API did not answer, so it is unknown whether a session exists. */
  | { status: "unreachable"; error: unknown };

interface AuthContextValue {
  state: AuthState;
  /** Rejects with an ApiError when the API refuses the credentials. */
  signIn: (username: string, password: string) => Promise<void>;
  /** Trades the portal's one-time ticket for a session. Rejects with an ApiError. */
  completeSso: (ticket: SsoTicket) => Promise<void>;
  /** Rejects when the API could not be told to end the session. */
  signOut: () => Promise<void>;
  /** Asks the API again whether a session exists. */
  restore: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ANONYMOUS: AuthState = { status: "anonymous", notice: null };

async function restoreSession(): Promise<AuthState> {
  try {
    if (!(await api.refresh())) return ANONYMOUS;
    // the API wraps the account the same way sign-in does: { user }
    const { user } = await api.request<{ user: User }>("/api/me");
    return { status: "authenticated", user };
  } catch (error) {
    if (isApiError(error) && error.code === SIGNED_OUT) return ANONYMOUS;
    if (isApiError(error) && error.code === "NO_ACCESS") return { status: "no-access" };
    return { status: "unreachable", error };
  }
}

// Shared by every mount of the provider, so React's development double mount
// does not send the refresh cookie twice.
let firstLoad: Promise<AuthState> | null = null;

function loadOnce(): Promise<AuthState> {
  // A portal ticket in the address bar is handled before anything else: the
  // callback page trades it for a session, so no refresh is sent here.
  firstLoad ??= readSsoTicket(window.location.search) ? Promise.resolve(ANONYMOUS) : restoreSession();
  return firstLoad;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void loadOnce().then((loaded) => {
      // A sign-in that finished first wins over the page-load result.
      if (active) setState((current) => (current.status === "loading" ? loaded : current));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => onSignedOut(() => setState({ status: "anonymous", notice: "expired" })), []);

  const startSession = useCallback((response: AuthResponse) => {
    api.setAccessToken(response.accessToken);
    setState({ status: "authenticated", user: response.user });
  }, []);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const response = await api.request<AuthResponse>("/api/auth/login", {
        method: "POST",
        body: { username, password },
        auth: false,
      });
      startSession(response);
    },
    [startSession],
  );

  const completeSso = useCallback(
    async (ticket: SsoTicket) => {
      const response = await api.request<AuthResponse>("/api/auth/sso/exchange", {
        method: "POST",
        body: { token: ticket.token, appId: ticket.appId },
        auth: false,
      });
      startSession(response);
    },
    [startSession],
  );

  const signOut = useCallback(async () => {
    try {
      await api.request("/api/auth/logout", { method: "POST" });
    } catch (error) {
      // An already ended session is as signed out as it gets.
      if (!(isApiError(error) && (error.code === SIGNED_OUT || error.status === 401))) throw error;
    }
    api.setAccessToken(null);
    setState(ANONYMOUS);
  }, []);

  const restore = useCallback(() => {
    setState({ status: "loading" });
    void restoreSession().then(setState);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ state, signIn, completeSso, signOut, restore }),
    [state, signIn, completeSso, signOut, restore],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
