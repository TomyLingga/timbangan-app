// What the sender loop hands to a push provider, and what comes back. FCM is the one provider (fcm.ts); tests pass
// their own.

/** One push to one device. Only generic text and ids: the message passes through a third party. */
export interface PushMessage {
  token: string;
  /** Null for a data-only message (no sound, nothing shown): the app reacts to `data` itself. */
  title: string | null;
  body: string | null;
  /** Ids and the notification type; FCM wants string values. */
  data: Record<string, string>;
  android: {
    priority: "high" | "normal";
    /** The notification channel of the app; FCM falls back to the app's default when it is absent. */
    channelId?: string;
    /** A later push with the same tag replaces the one still shown. */
    tag?: string;
    /** How long FCM keeps the message for a phone that is offline. */
    ttlS?: number;
  };
}

export type PushOutcome =
  /** Accepted; `ref` is the message name the provider gave. */
  | { status: "SENT"; ref: string }
  /** Refused for this message or device; trying again would not help. `unregistered`: the token is dead. */
  | { status: "REJECTED"; code: string; httpStatus: number | null; unregistered: boolean }
  /** The provider or the network failed, or our credentials were not accepted: the push stays pending. */
  | { status: "RETRY"; reason: string; httpStatus: number | null };

export interface PushSender {
  readonly provider: string;
  /** `validateOnly`: the provider checks the request without delivering anything. */
  send(message: PushMessage, options?: { validateOnly?: boolean }): Promise<PushOutcome>;
}
