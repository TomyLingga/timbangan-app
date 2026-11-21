import type { Metadata } from "next";

import { ControlRoomScreen } from "@/features/control-room/control-room-screen";

export const metadata: Metadata = { title: "Ruang kontrol" };

export default function ControlRoomPage() {
  return <ControlRoomScreen />;
}
