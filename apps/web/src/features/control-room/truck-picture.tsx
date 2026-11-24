import { cn } from "@/lib/utils";

// A tanker truck in side view, facing right, drawn for the plant map: the tank in the theme's primary colour, the cab
// and the wheels in the text colour, the window and the hubs in the card colour, so it reads on the card plate behind
// it in both themes. 64 x 32 units; the caller sets the size. Colours go through `style`, where var() always works.

const TANK = { fill: "var(--primary)" };
const TANK_DARK = { fill: "color-mix(in oklch, var(--primary) 66%, var(--foreground))" };
const BAND = { stroke: "color-mix(in oklch, var(--primary) 62%, var(--foreground))" };
const SHINE = { stroke: "var(--card)", strokeOpacity: 0.45 };
const INK = { fill: "var(--foreground)" };
const CARD = { fill: "var(--card)" };

export function TruckPicture({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 32" aria-hidden="true" focusable="false" className={cn("shrink-0", className)}>
      {/* tank with its manhole, two bands and a highlight */}
      <rect x="9" y="2.5" width="9" height="3" rx="1" style={TANK_DARK} />
      <rect x="2" y="5" width="40" height="16" rx="8" style={TANK} />
      <path d="M15 5.4 V20.6 M29 5.4 V20.6" strokeWidth="1.6" style={BAND} />
      <path d="M8 8.5 H36" strokeWidth="1.4" strokeLinecap="round" style={SHINE} />
      {/* chassis */}
      <rect x="1" y="21" width="61" height="3" rx="1" style={INK} />
      {/* cab with its window */}
      <path d="M44 21 V9 Q44 7 46 7 H54.5 L60.5 13.5 Q62.5 15 62.5 17.5 V21 Z" style={INK} />
      <path d="M47 9.5 H53.6 L58 14.2 H47 Z" style={CARD} />
      {/* wheels */}
      <g strokeWidth="1.2" style={{ ...INK, stroke: "var(--card)" }}>
        <circle cx="11" cy="25.5" r="4.6" />
        <circle cx="21.5" cy="25.5" r="4.6" />
        <circle cx="53" cy="25.5" r="4.6" />
      </g>
      <g style={CARD}>
        <circle cx="11" cy="25.5" r="1.5" />
        <circle cx="21.5" cy="25.5" r="1.5" />
        <circle cx="53" cy="25.5" r="1.5" />
      </g>
    </svg>
  );
}

/** The small warning triangle for a zone where a truck has stood past the long-wait limit. */
export function LongWaitMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 18" aria-hidden="true" focusable="false" className={cn("shrink-0", className)}>
      <path d="M10 1.2 L19 16.8 H1 Z" strokeWidth="1.4" strokeLinejoin="round" style={{ fill: "var(--warning)", stroke: "var(--card)" }} />
      <path d="M10 6.5 V11" strokeWidth="2" strokeLinecap="round" style={{ stroke: "var(--card)" }} />
      <circle cx="10" cy="13.9" r="1.15" style={CARD} />
    </svg>
  );
}
