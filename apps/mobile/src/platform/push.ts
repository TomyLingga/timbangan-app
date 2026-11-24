// Pushes on the phone, through expo-notifications (SDK 58). The web build uses push.web.ts.
// - The device push token on Android is the FCM registration token (getDevicePushTokenAsync). It only exists when
//   the build carries google-services.json; app.config.js then sets extra.pushEnabled.
// - A push with a notification part that comes while the app is in the background is shown by Android itself,
//   with the API's tag; expo-notifications lists it with a "foreign" identifier holding that tag.
// - A data-only push (EXCEPTION_CLOSED) reaches JavaScript in the background only through a task registered with
//   registerTaskAsync (expo-task-manager); see pushTask.ts.

import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { DECISION_CHANNEL, foregroundBehavior, type PushData, parsePushData, presentedForException } from "../notifications/push";

/** True on an Android build made with google-services.json. */
export const pushAvailable = Platform.OS === "android" && Constants.expoConfig?.extra?.pushEnabled === true;

export const appVersion: string | null = Constants.expoConfig?.version ?? null;

/** The decision channel: created at start (Android needs a channel before it shows the permission prompt). */
export async function setupChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(DECISION_CHANNEL, {
    name: "Permintaan keputusan",
    importance: Notifications.AndroidImportance.HIGH,
    sound: "default",
    enableVibrate: true,
    vibrationPattern: [0, 400, 200, 400],
  });
}

/** How a push is shown while the app is open. */
export function installForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const content = notification.request.content;
      return foregroundBehavior(parsePushData(content.data), !!content.title);
    },
  });
}

export type PermissionState = "granted" | "ask" | "denied";

export async function permissionState(): Promise<PermissionState> {
  const answer = await Notifications.getPermissionsAsync();
  if (answer.granted) return "granted";
  return answer.canAskAgain ? "ask" : "denied";
}

/** The system prompt (Android 13 and later); true when allowed. */
export async function askPermission(): Promise<boolean> {
  const answer = await Notifications.requestPermissionsAsync();
  return answer.granted;
}

export async function deviceToken(): Promise<string> {
  const token = await Notifications.getDevicePushTokenAsync();
  return String(token.data);
}

export function onTokenChange(listener: (token: string) => void): () => void {
  const subscription = Notifications.addPushTokenListener((token) => listener(String(token.data)));
  return () => subscription.remove();
}

/** A push came while the app is in the foreground. */
export function onReceived(listener: (data: PushData | null, identifier: string) => void): () => void {
  const subscription = Notifications.addNotificationReceivedListener((notification) =>
    listener(parsePushData(notification.request.content.data), notification.request.identifier),
  );
  return () => subscription.remove();
}

export interface Tap {
  data: PushData | null;
  /** Tells taps apart, so the one that started the app is not handled twice. */
  key: string;
}

const tapOf = (response: Notifications.NotificationResponse): Tap => ({
  data: parsePushData(response.notification.request.content.data),
  key: `${response.notification.request.identifier}|${response.notification.date}|${response.actionIdentifier}`,
});

export function onTap(listener: (tap: Tap) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => listener(tapOf(response)));
  return () => subscription.remove();
}

/** The tap that opened the app from a cold start, if any; cleared once read. */
export function takeLastTap(): Tap | null {
  const response = Notifications.getLastNotificationResponse();
  if (!response) return null;
  Notifications.clearLastNotificationResponse();
  return tapOf(response);
}

/** Takes away the shown notifications of a request, except `keep`. */
export async function dismissForException(exceptionId: number, keep?: string): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  const identifiers = presentedForException(
    exceptionId,
    presented.map((item) => ({ identifier: item.request.identifier, data: item.request.content.data })),
    keep,
  );
  await Promise.all(identifiers.map((identifier) => Notifications.dismissNotificationAsync(identifier).catch(() => undefined)));
}
