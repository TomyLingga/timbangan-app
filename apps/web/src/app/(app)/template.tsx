"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";

import { MOTION_BASE } from "@/lib/motion";

// A template remounts on every navigation between routes, which is what plays
// the short entrance. It tells the eye that the content area changed.
export default function AppTemplate({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: MOTION_BASE }}>
      {children}
    </motion.div>
  );
}
