// The web build (development and screenshots only) has no pushes: every call is a no-op and the inbox works
// from the API alone.

import type { PushData } from "../notifications/push";

export const pushAvailable = false;
export const appVersion: string | null = null;

export async function setupChannels(): Promise<void> {}
export function installForegroundHandler(): void {}

export type PermissionState = "granted" | "ask" | "denied";
export async function permissionState(): Promise<PermissionState> {
  return "denied";
}
export async function askPermission(): Promise<boolean> {
  return false;
}
export async function deviceToken(): Promise<string> {
  throw new Error("No push token on the web build");
}
export function onTokenChange(_listener: (token: string) => void): () => void {
  return () => undefined;
}
export function onReceived(_listener: (data: PushData | null, identifier: string) => void): () => void {
  return () => undefined;
}

export interface Tap {
  data: PushData | null;
  key: string;
}
export function onTap(_listener: (tap: Tap) => void): () => void {
  return () => undefined;
}
export function takeLastTap(): Tap | null {
  return null;
}
export async function dismissForException(_exceptionId: number, _keep?: string): Promise<void> {}
