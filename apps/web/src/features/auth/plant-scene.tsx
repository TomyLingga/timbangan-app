import { useId, type CSSProperties } from "react";

// The sign-in scene: an abstract site plan of the plant seen from above, with
// one truck driving the route every truck takes. It enters at the post, stops
// on the scale, at quality, at the unloading or loading bay, at the seal check,
// on the scale again, and leaves. The station it stands at lights up in the
// accent colour. Drawn here, no external image.
//
// Motion is SVG animation on one clock (the duration below), so the truck and
// the station lights never drift apart. Under reduced motion the moving layer
// is hidden and a still truck stands on the first scale (globals.css).

type Point = readonly [number, number];

/** The route, as straight segments. */
const ROUTE: readonly Point[] = [
  [30, 470],
  [520, 470],
  [520, 190],
  [680, 190],
  [680, 108],
  [240, 108],
  [240, 300],
  [40, 300],
];

interface Station {
  label: string;
  at: Point;
  /** Where the label sits, relative to the station. */
  labelAt: Point;
  anchor?: "start" | "middle" | "end";
}

const STATIONS: readonly Station[] = [
  { label: "Pos", at: [130, 470], labelAt: [0, 40], anchor: "middle" },
  { label: "Timbang 1", at: [330, 470], labelAt: [0, 40], anchor: "middle" },
  { label: "Mutu", at: [520, 350], labelAt: [-24, 4], anchor: "end" },
  { label: "Bongkar / muat", at: [680, 190], labelAt: [-24, 34], anchor: "end" },
  { label: "Segel", at: [430, 108], labelAt: [0, -24], anchor: "middle" },
  { label: "Timbang 2", at: [240, 220], labelAt: [24, 4], anchor: "start" },
];

const SPEED = 150; // route units per second
const DWELL = 1.1; // seconds at each station
const GAP = 1.2; // seconds between one truck leaving and the next arriving

const distance = (a: Point, b: Point) => Math.hypot(b[0] - a[0], b[1] - a[1]);

const SEGMENT_START: number[] = [];
const LENGTH = ROUTE.slice(1).reduce((sum, point, index) => {
  SEGMENT_START.push(sum);
  return sum + distance(ROUTE[index], point);
}, 0);

/** Distance along the route to a point that lies on it. */
function along(point: Point): number {
  for (let index = 0; index < ROUTE.length - 1; index += 1) {
    const [a, b] = [ROUTE[index], ROUTE[index + 1]];
    const length = distance(a, b);
    const offset = distance(a, point);
    if (Math.abs(offset + distance(point, b) - length) < 0.5) return SEGMENT_START[index] + offset;
  }
  return 0;
}

// The timeline: drive, stop at each station, drive on, leave.
const stops = STATIONS.map((station) => along(station.at));
const keyframes: Array<{ time: number; point: number }> = [{ time: 0, point: 0 }];
const windows: Array<{ arrive: number; leave: number }> = [];
let clock = 0;
let travelled = 0;
for (const stop of stops) {
  clock += (stop - travelled) / SPEED;
  keyframes.push({ time: clock, point: stop / LENGTH });
  windows.push({ arrive: clock, leave: clock + DWELL });
  clock += DWELL;
  keyframes.push({ time: clock, point: stop / LENGTH });
  travelled = stop;
}
clock += (LENGTH - travelled) / SPEED;
const ARRIVE_EXIT = clock;
keyframes.push({ time: clock, point: 1 });
const DURATION = clock + GAP;
keyframes.push({ time: DURATION, point: 1 });

const fixed = (value: number) => value.toFixed(4);
const KEY_TIMES = keyframes.map((frame) => fixed(frame.time / DURATION)).join(";");
const KEY_POINTS = keyframes.map((frame) => fixed(frame.point)).join(";");
const PATH = `M ${ROUTE.map(([x, y]) => `${x} ${y}`).join(" L ")}`;
const DUR = `${DURATION.toFixed(2)}s`;

function lightTimes({ arrive, leave }: { arrive: number; leave: number }): string {
  const fade = 0.25;
  return [0, arrive - fade, arrive, leave, leave + fade, DURATION].map((time) => fixed(Math.max(0, time) / DURATION)).join(";");
}

const TRUCK_FADE = `0;${fixed(0.5 / DURATION)};${fixed((ARRIVE_EXIT - 0.5) / DURATION)};${fixed(ARRIVE_EXIT / DURATION)};1`;

/** A truck seen from above, facing +x: trailer, then cab with two lamps. */
function Truck() {
  return (
    <g>
      <rect x="-19" y="-7" width="27" height="14" rx="3" fill="var(--secondary)" />
      <rect x="-16" y="-4.5" width="21" height="9" rx="2" fill="none" stroke="var(--background)" strokeOpacity="0.35" />
      <rect x="10" y="-6.5" width="9" height="13" rx="2.5" fill="var(--secondary)" />
      <rect x="17" y="-5" width="2.5" height="3" rx="1" fill="var(--signal)" />
      <rect x="17" y="2" width="2.5" height="3" rx="1" fill="var(--signal)" />
    </g>
  );
}

const label = "font-mono text-[11px] tracking-[0.02em]";

export function PlantScene({ className, fit = "meet" }: { className?: string; fit?: "meet" | "slice" }) {
  const firstScale = STATIONS[1].at;
  // Two scenes can be on one page (phone and desktop layouts); keep their pattern ids apart.
  const hatch = `scene-hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <svg
      viewBox="0 0 800 540"
      className={className}
      aria-hidden="true"
      focusable="false"
      preserveAspectRatio={`xMidYMid ${fit}`}
    >
      <defs>
        <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-strong)" strokeWidth="1" />
        </pattern>
      </defs>

      {/* Plant boundary, open where the road comes in and goes out. */}
      <path
        d="M 20 446 V 316 M 20 284 V 36 H 784 V 524 H 20 V 494"
        fill="none"
        stroke="var(--line-strong)"
        strokeDasharray="2 6"
        strokeLinecap="round"
      />

      {/* Mill buildings inside the loop. */}
      <g fill={`url(#${hatch})`} stroke="var(--line-strong)">
        <rect x="292" y="168" width="170" height="104" rx="3" />
        <rect x="292" y="296" width="110" height="120" rx="3" />
        <rect x="420" y="372" width="62" height="44" rx="3" />
      </g>

      {/* Storage tanks by the bay. */}
      <g fill="var(--card)" stroke="var(--line-strong)">
        <circle cx="742" cy="98" r="30" />
        <circle cx="742" cy="98" r="20" fill="none" strokeDasharray="3 4" />
        <circle cx="742" cy="178" r="30" />
        <circle cx="742" cy="178" r="20" fill="none" strokeDasharray="3 4" />
      </g>

      {/* The road: a wide band, then a flowing centre line. */}
      <path d={PATH} fill="none" stroke="var(--muted)" strokeWidth="26" strokeLinejoin="round" strokeLinecap="round" />
      <path
        d={PATH}
        fill="none"
        stroke="var(--line-strong)"
        strokeWidth="1.25"
        strokeLinejoin="round"
        style={{ "--route-length": LENGTH, strokeDasharray: LENGTH, animation: "route-draw 1.1s cubic-bezier(0.2,0,0,1) both" } as CSSProperties}
      />
      <path
        d={PATH}
        fill="none"
        stroke="var(--primary)"
        strokeOpacity="0.7"
        strokeWidth="1.25"
        strokeDasharray="6 8"
        style={{ animation: "route-flow 1.6s linear infinite" }}
      />

      {/* Weighbridges: hatched plates across the road. */}
      <g fill="var(--card)" stroke="var(--foreground)" strokeOpacity="0.55">
        <rect x="294" y="454" width="72" height="32" rx="2" />
        <rect x="224" y="186" width="32" height="68" rx="2" />
      </g>
      <g stroke="var(--line-strong)">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <line key={`a${index}`} x1={302 + index * 11} y1="458" x2={302 + index * 11} y2="482" />
        ))}
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <line key={`b${index}`} x1="228" y1={194 + index * 11} x2="252" y2={194 + index * 11} />
        ))}
      </g>

      {/* Post booth and its barrier. */}
      <rect x="116" y="426" width="28" height="18" rx="2" fill="var(--card)" stroke="var(--foreground)" strokeOpacity="0.55" />
      <line x1="146" y1="452" x2="146" y2="488" stroke="var(--signal)" strokeWidth="3" strokeLinecap="round" />

      {/* Quality lab, seal check. */}
      <rect x="544" y="334" width="34" height="30" rx="2" fill="var(--card)" stroke="var(--foreground)" strokeOpacity="0.55" />
      <rect x="418" y="130" width="24" height="18" rx="2" fill="var(--card)" stroke="var(--foreground)" strokeOpacity="0.55" />

      {/* Entry and exit marks. */}
      <g className={label} fill="var(--muted-foreground)">
        <text x="30" y="440">Masuk</text>
        <text x="40" y="276">Keluar</text>
      </g>
      <path d="M 30 300 l 10 -6 v 12 z" fill="var(--muted-foreground)" />

      {/* Stations: a node on the road, its name, and a light that is on while the truck stands there. */}
      {STATIONS.map((station, index) => {
        const [x, y] = station.at;
        return (
          <g key={station.label} style={{ animation: `rise-in 0.4s cubic-bezier(0.2,0,0,1) ${0.35 + index * 0.06}s both` }}>
            <circle cx={x} cy={y} r="5" fill="var(--background)" stroke="var(--foreground)" strokeOpacity="0.7" strokeWidth="1.5" />
            <text
              x={x + station.labelAt[0]}
              y={y + station.labelAt[1]}
              textAnchor={station.anchor}
              className={label}
              fill="var(--muted-foreground)"
            >
              {station.label}
            </text>
            <g className="scene-live" opacity="0">
              <circle cx={x} cy={y} r="17" fill="var(--signal)" fillOpacity="0.16" stroke="var(--signal)" strokeWidth="1.5" />
              <text
                x={x + station.labelAt[0]}
                y={y + station.labelAt[1]}
                textAnchor={station.anchor}
                className={`${label} font-semibold`}
                fill="var(--foreground)"
              >
                {station.label}
              </text>
              <animate
                attributeName="opacity"
                values="0;0;1;1;0;0"
                keyTimes={lightTimes(windows[index])}
                dur={DUR}
                repeatCount="indefinite"
              />
            </g>
          </g>
        );
      })}

      {/* Reduced motion: the first scale lit, a truck standing on it. */}
      <g className="scene-still">
        <circle cx={firstScale[0]} cy={firstScale[1]} r="17" fill="var(--signal)" fillOpacity="0.16" stroke="var(--signal)" strokeWidth="1.5" />
        <g transform={`translate(${firstScale[0]} ${firstScale[1]})`}>
          <Truck />
        </g>
      </g>

      {/* The truck. */}
      <g className="scene-live" opacity="0">
        <animateMotion
          dur={DUR}
          repeatCount="indefinite"
          path={PATH}
          rotate="auto"
          calcMode="linear"
          keyPoints={KEY_POINTS}
          keyTimes={KEY_TIMES}
        />
        <animate attributeName="opacity" values="0;1;1;0;0" keyTimes={TRUCK_FADE} dur={DUR} repeatCount="indefinite" />
        <Truck />
      </g>
    </svg>
  );
}
