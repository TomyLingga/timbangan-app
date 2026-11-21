// Main screens (Beranda, Cari, Keputusan, Profil) sit alone at the bottom of the stack: going to one closes the
// screens above and replaces the main screen, so old copies do not pile up underneath.

import { router } from "expo-router";

export type MainHref = "/beranda" | "/cari" | "/keputusan" | "/profil";

export function goToMain(href: MainHref): void {
  if (router.canDismiss()) router.dismissAll();
  router.replace(href);
}
