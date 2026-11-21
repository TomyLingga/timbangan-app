"use client";

import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";

import { formatNumber } from "@/lib/format";
import { MOTION_EASE } from "@/lib/motion";

/**
 * A count that runs up from zero once, when it first appears. Later changes
 * jump straight to the new value. The final number is in the DOM from the
 * first render, so screen readers and reduced motion get it directly.
 */
export function CountUp({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const played = useRef(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (played.current || reduceMotion || value === 0) {
      node.textContent = formatNumber(value);
      return;
    }
    played.current = true;
    const controls = animate(0, value, {
      duration: Math.min(0.5 + value * 0.01, 0.9),
      ease: MOTION_EASE,
      onUpdate: (latest) => {
        node.textContent = formatNumber(Math.round(latest));
      },
    });
    return () => {
      controls.stop();
      node.textContent = formatNumber(value);
    };
  }, [value, reduceMotion]);

  return (
    <span ref={ref} className={className}>
      {formatNumber(value)}
    </span>
  );
}
