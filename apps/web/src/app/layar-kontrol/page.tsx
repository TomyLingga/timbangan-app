import type { Metadata } from "next";

import { ControlRoomScreen } from "@/features/control-room/control-room-screen";

export const metadata: Metadata = { title: "Layar ruang kontrol" };

export default function WallScreenPage() {
  return <ControlRoomScreen wall />;
}
