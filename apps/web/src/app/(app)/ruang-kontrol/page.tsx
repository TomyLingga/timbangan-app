import type { Metadata } from "next";

import { ControlRoomScreen } from "@/features/control-room/control-room-screen";

// The layout shows this page only after the session is checked in the browser, so the prerender never reaches it;
// without this, instant-navigation validation reports the page as a dropped segment.
export const instant = false;

export const metadata: Metadata = { title: "Ruang kontrol" };

export default function ControlRoomPage() {
  return <ControlRoomScreen />;
}
