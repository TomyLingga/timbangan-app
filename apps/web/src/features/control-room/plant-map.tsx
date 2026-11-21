"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

import {
  type ControlRoomState,
  type ControlRoomTruck,
  type ControlRoomZone,
  FLOW_LABELS,
  formatWait,
  HELD_LABELS,
  isLongWait,
  markerCapacity,
  markerFits,
  minutesSince,
  placeMarkers,
  type Point,
  shapeBox,
  shortZoneName,
} from "@/lib/control-room";
import type { PlanDrawing } from "@/features/control-room/use-control-room";
import { MOTION_EASE } from "@/lib/motion";
import { cn } from "@/lib/utils";

// The plant map: the plan as the base layer (the owner's layout picture when the site has one, else the line
// drawing), the zones as translucent fills in their seeded colours, and a marker per truck inside the plant. Markers
// sit on a grid inside their zone's box; when a truck's zone changes its marker glides to the new place. A truck that
// arrives fades in at the registration post and then moves to its zone.
//
// One SVG holds the picture and the zones and does not change while trucks move; the markers are HTML on top of it
// and only animate when their place changes. The picture is a light CAD print: in the dark theme it is inverted
// (light lines on a dark ground, hues kept) with its contrast lowered, a static filter that is drawn once.

/** Pill markers above this map width; dots below it. */
const COMPACT_BELOW_PX = 640;
const GLIDE_S = 0.6;
const MIN_PLATES_BEFORE_DOTS = 4;

interface MarkerSize {
  width: number;
  height: number;
  gap: number;
}

type MarkerKind = "pill" | "tv" | "dot" | "tvDot";

const SIZES: Record<MarkerKind, MarkerSize> = {
  pill: { width: 82, height: 22, gap: 4 },
  tv: { width: 116, height: 34, gap: 6 },
  dot: { width: 12, height: 12, gap: 4 },
  tvDot: { width: 20, height: 20, gap: 6 },
};

export interface PlantMapProps {
  state: ControlRoomState;
  plan: Pick<PlanDrawing, "markup" | "imageUrl" | "backdrop">;
  now: Date;
  tv?: boolean;
  /** Opens a truck's timeline; without it markers still show their tooltip on hover and focus. */
  onSelect?: (tripId: number) => void;
}

/** Fill strength of the zones: stronger over the picture, which has its own colours and lines. */
const ZONE_FILL = { image: 0.42, svg: 0.26 };
/** The dark-theme treatment of the picture (see the note at the top). */
const DARK_PICTURE = "dark:[filter:invert(1)_hue-rotate(180deg)_brightness(0.92)_contrast(0.82)]";

interface Placed {
  truck: ControlRoomTruck;
  at: Point;
  kind: MarkerKind;
}

/** Truck description for tooltips and screen readers. */
export function describeTruck(truck: ControlRoomTruck, zone: ControlRoomZone | undefined, now: Date): string {
  const parts = [
    truck.plateDisplay ?? "Tanpa plat",
    truck.direction === "IN" ? "incoming" : "outgoing",
    truck.held ? HELD_LABELS[truck.held.type] ?? "Ditahan" : truck.stepName ? `${truck.stepStatus === "IN_PROGRESS" ? "sedang" : "menunggu"} ${truck.stepName}` : null,
    zone ? `di ${shortZoneName(zone)}` : null,
    formatWait(minutesSince(truck.since, now)),
  ];
  return parts.filter(Boolean).join(", ");
}

export function PlantMap({ state, plan, now, tv = false, onSelect }: PlantMapProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const aspect = plan.backdrop;
  const picture = plan.backdrop.kind === "image" && plan.imageUrl ? plan.imageUrl : null;

  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const compact = !tv && size.width > 0 && size.width < COMPACT_BELOW_PX;
  // plates where they fit; a zone too small for its trucks' plates shows them as dots (the plate is in the tooltip)
  const large: MarkerKind = tv ? "tv" : compact ? "dot" : "pill";
  const small: MarkerKind = tv ? "tvDot" : "dot";
  const zonesByCode = useMemo(() => new Map(state.zones.map((zone) => [zone.code, zone])), [state.zones]);

  // trucks seen before; a truck that appears later starts at the registration post
  const seen = useRef<Set<number> | null>(null);
  const [arriving, setArriving] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    const ids = state.trucks.map((truck) => truck.tripId);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !seen.current?.has(id));
    for (const id of ids) seen.current.add(id);
    if (fresh.length === 0 || reduceMotion) return;
    setArriving((current) => new Set([...current, ...fresh]));
    // one frame at the post, then the glide to the zone
    const timer = setTimeout(() => setArriving((current) => new Set([...current].filter((id) => !fresh.includes(id)))), 420);
    return () => clearTimeout(timer);
  }, [state.trucks, reduceMotion]);

  const { placed, chips, regCentre } = useMemo(() => {
    const result: Placed[] = [];
    const overflowChips: { zone: string; at: Point; count: number }[] = [];
    const toPx = (box: NonNullable<ReturnType<typeof shapeBox>>) => ({
      x: box.x * size.width,
      y: box.y * size.height,
      width: box.width * size.width,
      height: box.height * size.height,
    });
    const regBox = shapeBox(zonesByCode.get("REG")?.shape ?? null);
    const reg = regBox ? toPx(regBox) : null;
    if (size.width === 0) return { placed: result, chips: overflowChips, regCentre: null };
    const byZone = new Map<string, ControlRoomTruck[]>();
    for (const truck of state.trucks) {
      const list = byZone.get(truck.zone) ?? [];
      list.push(truck);
      byZone.set(truck.zone, list);
    }
    for (const [code, trucks] of byZone) {
      const box = shapeBox(zonesByCode.get(code)?.shape ?? null);
      if (!box) continue;
      // held trucks first, then the longest waiting
      const ordered = [...trucks].sort((a, b) => Number(!!b.held) - Number(!!a.held) || a.since.localeCompare(b.since) || a.tripId - b.tripId);
      const pixels = toPx(box);
      // a zone that holds a few plates keeps them and counts the rest on the chip; one that holds fewer, or that is
      // too small for one plate, switches to dots
      const capacity = markerCapacity(pixels, SIZES[large]);
      const kind = !markerFits(pixels, SIZES[large]) || (ordered.length > capacity && capacity < MIN_PLATES_BEFORE_DOTS) ? small : large;
      const layout = placeMarkers(pixels, ordered.length, SIZES[kind]);
      layout.slots.forEach((slot, index) => {
        const truck = ordered[index];
        if (truck) result.push({ truck, at: slot, kind });
      });
      if (layout.overflowSlot) overflowChips.push({ zone: code, at: layout.overflowSlot, count: layout.overflow });
    }
    return { placed: result, chips: overflowChips, regCentre: reg ? { x: reg.x + reg.width / 2, y: reg.y + reg.height / 2 } : null };
  }, [state.trucks, zonesByCode, size, large, small]);

  const [hovered, setHovered] = useState<number | null>(null);
  const hoveredPlaced = hovered === null ? null : placed.find((item) => item.truck.tripId === hovered) ?? null;
  const percent = (point: Point) => ({ left: `${(point.x / Math.max(size.width, 1)) * 100}%`, top: `${(point.y / Math.max(size.height, 1)) * 100}%` });

  return (
    <div
      ref={frame}
      className="relative w-full"
      style={{ aspectRatio: `${aspect.width} / ${aspect.height}` }}
      data-testid="plant-map"
    >
      {/* the line drawing (when there is no picture): lines only, coloured by the theme */}
      {!picture && plan.markup ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 text-faint [&_*]:[vector-effect:non-scaling-stroke] [&>svg]:size-full"
          dangerouslySetInnerHTML={{ __html: plan.markup }}
        />
      ) : null}

      {/* the picture and the zones */}
      <svg aria-hidden="true" className="absolute inset-0 size-full" viewBox={`0 0 ${aspect.width} ${aspect.height}`} preserveAspectRatio="none">
        {picture ? (
          <image
            href={picture}
            x={0}
            y={0}
            width={aspect.width}
            height={aspect.height}
            preserveAspectRatio="none"
            data-testid="plan-image"
            className={DARK_PICTURE}
          />
        ) : null}
        {state.zones.map((zone) => {
          if (!zone.shape || zone.shape.length < 3) return null;
          const points = zone.shape.map(([x = 0, y = 0]) => `${x * aspect.width},${y * aspect.height}`).join(" ");
          const color = zone.color ?? "var(--muted-foreground)";
          return (
            <polygon
              key={zone.code}
              points={points}
              fill={color}
              fillOpacity={picture ? ZONE_FILL.image : ZONE_FILL.svg}
              stroke={color}
              strokeOpacity={0.95}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      {/* zone names; a narrow map leaves them to the list beside or under it, where they do not cover the markers */}
      {size.width > 0 && !compact
        ? state.zones.map((zone) => {
            const box = shapeBox(zone.shape);
            if (!box) return null;
            return (
              <span
                key={zone.code}
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute z-20 -translate-y-full truncate pb-0.5 font-medium leading-none text-foreground/80 [text-shadow:0_0_3px_var(--background),0_0_6px_var(--background)]",
                  tv ? "text-sm" : "text-[0.6875rem]",
                )}
                style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, maxWidth: `${Math.max(box.width * 100, 9)}%` }}
              >
                {shortZoneName(zone)}
              </span>
            );
          })
        : null}

      {/* markers */}
      <AnimatePresence initial={false}>
        {placed.map(({ truck, at, kind }) => {
          const target = arriving.has(truck.tripId) && regCentre ? regCentre : at;
          return (
            <motion.div
              key={truck.tripId}
              layout={reduceMotion ? false : "position"}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, transition: { duration: 0.4 } }}
              transition={{ layout: { duration: GLIDE_S, ease: MOTION_EASE }, opacity: { duration: 0.35 } }}
              className={cn("absolute size-0", truck.held ? "z-20" : "z-10")}
              style={percent(target)}
            >
              <TruckMarker
                truck={truck}
                zone={zonesByCode.get(truck.zone)}
                now={now}
                kind={kind}
                interactive={!tv}
                onSelect={onSelect}
                onHover={setHovered}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>

      {chips.map((chip) => (
        <span
          key={`more-${chip.zone}`}
          className={cn(
            "absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-card font-mono font-semibold text-foreground shadow-panel",
            tv ? "h-8 min-w-12 px-2 text-sm" : compact ? "h-3.5 min-w-5 px-1 text-[0.5625rem]" : "h-[22px] min-w-10 px-1.5 text-[0.6875rem]",
          )}
          style={percent(chip.at)}
          aria-label={`${chip.count} truk lagi di ${shortZoneName(zonesByCode.get(chip.zone) ?? { code: chip.zone, name: chip.zone })}`}
        >
          +{chip.count}
        </span>
      ))}

      {hoveredPlaced && !tv ? <MarkerTooltip item={hoveredPlaced} zone={zonesByCode.get(hoveredPlaced.truck.zone)} now={now} style={percent(hoveredPlaced.at)} compact={compact} /> : null}
    </div>
  );
}

interface TruckMarkerProps {
  truck: ControlRoomTruck;
  zone: ControlRoomZone | undefined;
  now: Date;
  kind: MarkerKind;
  interactive: boolean;
  onSelect?: (tripId: number) => void;
  onHover: (tripId: number | null) => void;
}

function TruckMarker({ truck, zone, now, kind, interactive, onSelect, onHover }: TruckMarkerProps) {
  const incoming = truck.direction === "IN";
  const long = isLongWait(truck.since, now);
  const fill = incoming ? "var(--stream-in)" : "var(--stream-out)";
  const background = long ? `color-mix(in oklch, ${fill} 62%, var(--warning))` : fill;
  const heldMinutes = truck.held ? minutesSince(truck.held.since, now) : null;
  const label = describeTruck(truck, zone, now);
  const common = {
    "aria-label": interactive && onSelect ? `${label}. Buka garis waktu.` : label,
    "data-trip": truck.tripId,
    "data-zone": truck.zone,
    "data-held": truck.held ? "true" : undefined,
    "data-long": long ? "true" : undefined,
    onMouseEnter: interactive ? () => onHover(truck.tripId) : undefined,
    onMouseLeave: interactive ? () => onHover(null) : undefined,
    onFocus: interactive ? () => onHover(truck.tripId) : undefined,
    onBlur: interactive ? () => onHover(null) : undefined,
    onClick: interactive && onSelect ? () => onSelect(truck.tripId) : undefined,
  };
  const ring = truck.held ? "ring-2 ring-signal ring-offset-1 ring-offset-card" : long ? "ring-1 ring-warning" : "";

  if (kind === "dot" || kind === "tvDot") {
    return (
      <button
        type="button"
        {...common}
        tabIndex={interactive ? 0 : -1}
        className={cn(
          "absolute -translate-x-1/2 -translate-y-1/2 rounded-full shadow-panel outline-none focus-visible:ring-3 focus-visible:ring-ring/60",
          ring,
          kind === "tvDot" ? "size-5" : "size-3",
          interactive ? "hover:scale-125" : "pointer-events-none",
        )}
        style={{ background }}
      />
    );
  }

  const tv = kind === "tv";
  return (
    <button
      type="button"
      {...common}
      tabIndex={interactive ? 0 : -1}
      className={cn(
        "absolute flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full font-mono font-semibold whitespace-nowrap text-primary-foreground shadow-raised outline-none transition-transform duration-150 focus-visible:ring-3 focus-visible:ring-ring/60",
        interactive ? "hover:scale-105" : "pointer-events-none",
        tv ? "h-[34px] w-[116px] text-[0.75rem] tracking-[0.02em]" : "h-[22px] w-[82px] text-[0.65rem] tracking-[0.03em]",
        ring,
      )}
      style={{ background, fontVariantLigatures: "none" }}
    >
      <span className={cn("truncate", kind === "tv" ? "px-1" : "px-1.5")}>{truck.plateDisplay ?? "?"}</span>
      {heldMinutes !== null ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute -top-2 -right-2 rounded-full bg-signal px-1 font-sans font-bold text-signal-foreground tabular-nums shadow-panel",
            tv ? "text-xs leading-5" : "text-[0.5625rem] leading-3.5",
          )}
        >
          {formatWait(heldMinutes).replace(" mnt", "m").replace(" j", "j")}
        </span>
      ) : null}
    </button>
  );
}

function MarkerTooltip({ item, zone, now, style, compact }: { item: Placed; zone: ControlRoomZone | undefined; now: Date; style: { left: string; top: string }; compact: boolean }) {
  const { truck } = item;
  const minutes = minutesSince(truck.since, now);
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 w-max max-w-60 -translate-x-1/2 rounded-xl border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-overlay"
      style={{ ...style, transform: `translate(-50%, calc(-100% - ${compact ? 12 : 18}px))` }}
    >
      <p className="plate text-sm">{truck.plateDisplay ?? "Tanpa plat"}</p>
      <p className="mt-1.5 text-muted-foreground">
        {FLOW_LABELS[truck.flowCode] ?? truck.flowCode}
        {truck.tripNo ? ` · ${truck.tripNo}` : ""}
      </p>
      <p className="mt-0.5">
        {truck.held
          ? HELD_LABELS[truck.held.type] ?? "Ditahan"
          : truck.stepName
            ? `${truck.stepStatus === "IN_PROGRESS" ? "Sedang" : "Menunggu"} ${truck.stepName.toLowerCase()}`
            : "Baru masuk"}
      </p>
      <p className={cn("mt-0.5 tabular-nums", isLongWait(truck.since, now) ? "text-warning" : "text-muted-foreground")}>
        {formatWait(minutes)} di {zone ? shortZoneName(zone) : truck.zone}
      </p>
    </div>
  );
}
