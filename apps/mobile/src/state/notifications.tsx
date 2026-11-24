// Notifications for the signed-in account: the unread count of the inbox, pushes (permission, token
// registration, taps, closed requests) and a counter that screens watch to reload after a push.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { router, usePathname } from "expo-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { loadUnreadCount, markRead } from "../notifications/inbox";
import { deviceRegistrar, EXCEPTION_CLOSED, EXCEPTION_RAISED, type PushData, type PushTarget, pushEvents, pushTarget } from "../notifications/push";
import {
  appVersion,
  askPermission,
  deviceToken,
  dismissForException,
  onReceived,
  onTap,
  onTokenChange,
  permissionState,
  pushAvailable,
  type Tap,
  takeLastTap,
} from "../platform/push";
import { Button, Sheet, T } from "../ui/kit";
import { useSession } from "./session";

const ASKED_KEY = "push-permission-asked-v1";

interface NotificationsValue {
  unreadCount: number;
  /** Goes up after every push; screens that list requests or notifications reload on it. */
  pushVersion: number;
  refreshUnread(): Promise<void>;
  setUnreadCount(count: number): void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { api, status, user } = useSession();
  const pathname = usePathname();
  const [unreadCount, setUnreadCount] = useState(0);
  const [pushVersion, setPushVersion] = useState(0);
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState<{ target: PushTarget; notificationId: number | null } | null>(null);
  const handledTaps = useRef(new Set<string>());
  const signedIn = status === "signedIn";
  const accountId = user?.id ?? null;

  const refreshUnread = useCallback(async () => {
    if (!signedIn) return;
    try {
      setUnreadCount(await loadUnreadCount(api));
    } catch {
      // without signal the last count stays
    }
  }, [api, signedIn]);

  useEffect(() => {
    if (signedIn) void refreshUnread();
    else setUnreadCount(0);
  }, [signedIn, refreshUnread]);

  // back to the foreground: the count may have changed meanwhile
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshUnread();
    });
    return () => subscription.remove();
  }, [refreshUnread]);

  // a push (foreground listener or background task): the count and the lists reload, coalesced
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const afterPush = useCallback(() => {
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
    bumpTimer.current = setTimeout(() => {
      bumpTimer.current = null;
      setPushVersion((value) => value + 1);
      void refreshUnread();
    }, 300);
  }, [refreshUnread]);
  useEffect(() => () => {
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
  }, []);

  useEffect(() => pushEvents.subscribe(afterPush), [afterPush]);
  useEffect(
    () =>
      onReceived((data: PushData | null, identifier: string) => {
        if (data?.exceptionId != null) {
          // a reminder replaces the request's notification; a closed request takes it away
          if (data.type === EXCEPTION_RAISED) void dismissForException(data.exceptionId, identifier).catch(() => undefined);
          if (data.type === EXCEPTION_CLOSED) void dismissForException(data.exceptionId).catch(() => undefined);
        }
        afterPush();
      }),
    [afterPush],
  );

  // taps: from a cold start (the last response) and while running
  const handleTap = useCallback((tap: Tap | null) => {
    if (!tap || handledTaps.current.has(tap.key)) return;
    handledTaps.current.add(tap.key);
    setPending({ target: pushTarget(tap.data), notificationId: tap.data?.notificationId ?? null });
  }, []);
  useEffect(() => {
    handleTap(takeLastTap());
    return onTap(handleTap);
  }, [handleTap]);

  // open the target once the session is known and the start screen has moved on; the entry counts as read
  useEffect(() => {
    if (!pending) return;
    if (status === "signedOut") {
      setPending(null);
      return;
    }
    if (!signedIn || pathname === "/") return;
    setPending(null);
    if (pending.notificationId !== null) void markRead(api, pending.notificationId).then((answer) => setUnreadCount(answer.unreadCount), () => undefined);
    const { target } = pending;
    if (target.kind === "decision") router.push({ pathname: "/keputusan/[id]", params: { id: String(target.exceptionId) } });
    else router.push("/pemberitahuan");
  }, [pending, status, signedIn, pathname, api]);

  // the permission (asked once) and the token of this phone
  const register = useCallback(async () => {
    if (accountId === null) return;
    const token = await deviceToken();
    await deviceRegistrar.sync(api, token, appVersion, accountId);
  }, [api, accountId]);

  useEffect(() => {
    if (!pushAvailable || !signedIn || accountId === null) return;
    let alive = true;
    (async () => {
      const state = await permissionState().catch(() => "denied" as const);
      if (!alive) return;
      if (state === "granted") {
        await register().catch(() => undefined);
        return;
      }
      if (state === "ask" && !(await AsyncStorage.getItem(ASKED_KEY).catch(() => null)) && alive) setAsking(true);
    })();
    const stop = onTokenChange((token) => void deviceRegistrar.sync(api, token, appVersion, accountId).catch(() => undefined));
    return () => {
      alive = false;
      stop();
    };
  }, [signedIn, accountId, api, register]);

  const answerPrompt = async (allow: boolean) => {
    setAsking(false);
    await AsyncStorage.setItem(ASKED_KEY, "1").catch(() => undefined);
    if (allow && (await askPermission().catch(() => false))) await register().catch(() => undefined);
  };

  const value = useMemo<NotificationsValue>(() => ({ unreadCount, pushVersion, refreshUnread, setUnreadCount }), [unreadCount, pushVersion, refreshUnread]);

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <Sheet
        visible={asking && signedIn}
        onClose={() => void answerPrompt(false)}
        title="Pemberitahuan"
        testID="push-permission"
        footer={
          <>
            <Button label="Izinkan" icon="bell" onPress={() => void answerPrompt(true)} testID="push-allow" />
            <Button label="Nanti saja" kind="secondary" onPress={() => void answerPrompt(false)} />
          </>
        }
      >
        <T>Izinkan pemberitahuan supaya permintaan keputusan langsung muncul di ponsel, walau aplikasi tertutup.</T>
      </Sheet>
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications outside NotificationsProvider");
  return value;
}
