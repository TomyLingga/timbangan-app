// What the app does with a push from the API (apps/api/src/notifications): read its data, decide whether it is
// shown while the app is open, where a tap leads, which shown notifications belong to a request, and keeping
// this phone's token registered for the signed-in account. No React Native imports, so it runs under Vitest.

import type { ApiClient } from "../api/client";
import type { DeviceBody, DeviceResponse } from "../api/types";

export const EXCEPTION_RAISED = "EXCEPTION_RAISED";
export const EXCEPTION_CLOSED = "EXCEPTION_CLOSED";
export const DO_SENT = "DO_SENT";

/** Android channel of the decision requests; the API sends EXCEPTION_RAISED with this channel_id. */
export const DECISION_CHANNEL = "keputusan";

export interface PushData {
  type: string;
  notificationId: number | null;
  exceptionId: number | null;
  tripId: number | null;
  deliveryOrderId: number | null;
}

const idOf = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The data of a push. FCM data values are strings; a tap on a notification Android showed itself carries them
 * among the intent extras, next to google.* keys. A JSON `dataString` (set by expo-notifications when the data
 * has a JSON `body`) is read too. Null when it is not one of ours.
 */
export function parsePushData(raw: unknown): PushData | null {
  if (typeof raw !== "object" || raw === null) return null;
  let source = raw as Record<string, unknown>;
  if (typeof source.type !== "string" && typeof source.dataString === "string") {
    try {
      const parsed = JSON.parse(source.dataString) as unknown;
      if (typeof parsed === "object" && parsed !== null) source = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  if (typeof source.type !== "string" || !source.type) return null;
  return {
    type: source.type,
    notificationId: idOf(source.notificationId),
    exceptionId: idOf(source.exceptionId),
    tripId: idOf(source.tripId),
    deliveryOrderId: idOf(source.deliveryOrderId),
  };
}

export type PushTarget = { kind: "decision"; exceptionId: number } | { kind: "inbox" };

/** Where a tap leads: a request opens its decision screen, everything else the inbox. */
export function pushTarget(data: PushData | null): PushTarget {
  if (data?.type === EXCEPTION_RAISED && data.exceptionId !== null) return { kind: "decision", exceptionId: data.exceptionId };
  return { kind: "inbox" };
}

export interface ForegroundBehavior {
  shouldShowBanner: boolean;
  shouldShowList: boolean;
  shouldPlaySound: boolean;
  shouldSetBadge: boolean;
}

/** While the app is open: a request is shown with sound, other notifications quietly, data-only messages not at all. */
export function foregroundBehavior(data: PushData | null, hasTitle: boolean): ForegroundBehavior {
  const shown = hasTitle && data?.type !== EXCEPTION_CLOSED;
  return { shouldShowBanner: shown, shouldShowList: shown, shouldPlaySound: shown && data?.type === EXCEPTION_RAISED, shouldSetBadge: false };
}

/** The Android tag the API gives the notification of a request; a reminder carries the same tag. */
export const exceptionTag = (exceptionId: number) => `exception-${exceptionId}`;

/**
 * The tag inside an identifier expo-notifications gives a notification that Android showed without it (a push that
 * came while the app was in the background): `expo-notifications://foreign_notifications?tag=...&id=0`.
 */
export function tagOf(identifier: string): string | null {
  const match = /[?&]tag=([^&]*)/.exec(identifier);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1].replace(/\+/g, " "));
  } catch {
    return match[1];
  }
}

export interface PresentedNotification {
  identifier: string;
  data: unknown;
}

/**
 * The shown notifications that belong to a request: shown by Android with the request's tag, or shown by the app
 * with the request in its data. `keep` leaves one out (the reminder that just arrived).
 */
export function presentedForException(exceptionId: number, presented: PresentedNotification[], keep?: string): string[] {
  const tag = exceptionTag(exceptionId);
  return presented
    .filter((item) => item.identifier !== keep)
    .filter((item) => tagOf(item.identifier) === tag || item.identifier === tag || parsePushData(item.data)?.exceptionId === exceptionId)
    .map((item) => item.identifier);
}

// --- device registration -----------------------------------------------------------------------------------

type Requester = Pick<ApiClient, "request">;

export const devicePath = (token: string) => `/api/devices/${encodeURIComponent(token)}`;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export interface DeviceRegistrar {
  /**
   * Sends the token unless this token was already sent for this account since the app started. A failure is
   * thrown; the next call tries again.
   */
  sync(api: Requester, token: string, appVersion: string | null, accountId: number): Promise<void>;
  /**
   * At sign-out, before the session is dropped: the phone gets no more pushes for this account. Without a token
   * sent in this run, `fallbackToken` gives the phone's token. Never throws.
   */
  unregister(api: Requester, fallbackToken?: () => Promise<string | null>): Promise<void>;
  /** The token last sent, if any. */
  current(): string | null;
}

export function createDeviceRegistrar(): DeviceRegistrar {
  let registered: string | null = null;
  let registeredFor: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  // one call at a time, so a token change during a sign-in does not cross the first registration
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    sync(api, token, appVersion, accountId) {
      return serial(async () => {
        if (!token || (token === registered && accountId === registeredFor)) return;
        const body: DeviceBody = { platform: "ANDROID", pushToken: token, appVersion };
        await api.request<DeviceResponse>("/api/devices", { method: "POST", body });
        registered = token;
        registeredFor = accountId;
      });
    },
    unregister(api, fallbackToken) {
      return serial(async () => {
        let token = registered;
        registered = null;
        registeredFor = null;
        // not sent in this run (no signal at start): the server may still hold it from an earlier run
        if (!token && fallbackToken) token = await withTimeout(fallbackToken(), 3_000).catch(() => null);
        if (!token) return;
        await api.request(devicePath(token), { method: "DELETE", timeoutMs: 5_000 }).catch(() => undefined);
      });
    },
    current: () => registered,
  };
}

/** The one registrar of the app: the session calls unregister at sign-out, the notifications provider calls sync. */
export const deviceRegistrar = createDeviceRegistrar();

// --- events inside the app ---------------------------------------------------------------------------------

type PushListener = (data: PushData) => void;
const listeners = new Set<PushListener>();

/** A push came (foreground listener or background task): screens that show requests or the inbox reload. */
export const pushEvents = {
  emit(data: PushData) {
    for (const listener of [...listeners]) {
      try {
        listener(data);
      } catch {
        // a broken listener must not stop the others
      }
    }
  },
  subscribe(listener: PushListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
