// A made-up plant for the tests, the mock API and a database without an imported plan. It is not the real site: the
// real drawing and zone positions stay out of the repository (docs/fase-6-rancangan.md section 4) and are loaded
// with `npm run plan:import`. Lines only, in currentColor, so the page colours the drawing with its theme.

export const DEMO_PLAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 560" fill="none" stroke="currentColor" stroke-width="1" stroke-linejoin="round">
  <title>Denah contoh</title>
  <g class="plan-boundary" stroke-width="1.4">
    <path d="M800 540 H40 Q20 540 20 520 V40 Q20 20 40 20 H960 Q980 20 980 40 V520 Q980 540 960 540 H860" />
  </g>
  <g class="plan-road" stroke-opacity="0.55">
    <rect x="50" y="50" width="900" height="460" rx="30" />
    <rect x="76" y="76" width="848" height="408" rx="16" />
    <path d="M440 76 V484 M466 76 V306 M466 334 V484 M466 306 H924 M466 334 H924" />
    <path d="M810 510 V540 M850 510 V540" />
  </g>
  <g class="plan-bund" stroke-dasharray="4 4" stroke-opacity="0.6">
    <rect x="96" y="96" width="328" height="128" rx="6" />
  </g>
  <g class="plan-tank">
    <circle cx="140" cy="160" r="34" />
    <circle cx="210" cy="160" r="30" />
    <circle cx="275" cy="160" r="30" />
    <circle cx="340" cy="160" r="30" />
    <circle cx="396" cy="160" r="20" />
  </g>
  <g class="plan-building">
    <rect x="490" y="96" width="140" height="120" rx="4" />
    <path d="M490 136 H630 M560 96 V216" stroke-opacity="0.5" />
    <rect x="700" y="190" width="200" height="100" rx="4" />
    <path d="M700 240 H900" stroke-opacity="0.5" />
    <rect x="690" y="96" width="210" height="70" rx="4" />
    <rect x="110" y="266" width="64" height="92" rx="4" />
    <rect x="500" y="420" width="140" height="56" rx="4" />
    <rect x="110" y="400" width="80" height="60" rx="4" />
  </g>
  <g class="plan-weighbridge" stroke-width="1.2">
    <rect x="592" y="352" width="76" height="30" rx="2" />
    <path d="M604 352 V382 M616 352 V382 M628 352 V382 M640 352 V382 M652 352 V382" stroke-opacity="0.5" />
  </g>
</svg>
`;

const box = (x1: number, y1: number, x2: number, y2: number): number[][] => [
  [x1, y1],
  [x2, y1],
  [x2, y2],
  [x1, y2],
];

/** Zone polygons on the demo plan, as fractions of its width and height. */
export const DEMO_ZONE_SHAPES: Record<string, number[][]> = {
  REG: box(0.79, 0.8, 0.87, 0.95),
  QUEUE: box(0.7, 0.62, 0.9, 0.78),
  WB: box(0.58, 0.61, 0.68, 0.7),
  QC: box(0.49, 0.61, 0.555, 0.7),
  STAGING: box(0.3, 0.44, 0.42, 0.8),
  DOCK: box(0.58, 0.34, 0.68, 0.42),
  SEAL: box(0.58, 0.45, 0.68, 0.53),
  LOADING: box(0.19, 0.67, 0.27, 0.84),
  UNLOADING: box(0.19, 0.46, 0.27, 0.63),
};
