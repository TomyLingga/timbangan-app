"use client";

import type { ReactNode } from "react";
import { MotionConfig } from "motion/react";

import { AuthProvider } from "@/features/auth/auth-provider";
import { MOTION_EASE } from "@/lib/motion";

export function Providers({ children }: { children: ReactNode }) {
  return (
    // reducedMotion="user": people who ask for less motion get opacity changes
    // only; movement and layout animation are switched off.
    <MotionConfig reducedMotion="user" transition={{ duration: 0.18, ease: MOTION_EASE }}>
      <AuthProvider>{children}</AuthProvider>
    </MotionConfig>
  );
}
