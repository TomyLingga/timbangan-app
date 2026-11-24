"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import type { PlanDrawing } from "@/features/control-room/use-control-room";
import { LongWaitMark, TruckPicture } from "@/features/control-room/truck-picture";
import { type ControlRoomState, type ControlRoomTruck, type Point, shapeBox, shortZoneName } from "@/lib/control-room";
import { detectMoves, groupTrucksByZone, type Move, spreadBadges, zoneLabel } from "@/lib/control-room-map";
import { cn } from "@/lib/utils";

// The plant map: the plan as the base layer (the owner's layout picture when the site has one, else the line
// drawing), the zones as translucent fills in their seeded colours with their names, and on each zone that holds
// trucks one truck picture with the number of trucks, on a solid card plate so it reads on the busy CAD print in both
// themes. The plate is a button that opens the zone's plate list (not on the wall screen). Plates of neighbouring
// zones are pushed apart so they do not cover each other.
//
// When a truck changes zone, a small truck picture travels from the old zone's plate to the new one and only then do
// the counts change; a few travel at once at most, the other moves just change the counts. No travel with reduced
// motion.
//
// The picture is a light CAD print: in the dark theme it is inverted (light lines on a dark ground, hues kept) with
// its contrast lowered, a static filter that is drawn once.

/** Small plates below this map width (the phone). */
const COMPACT_BELOW_PX = 640;
const TRAVEL_MS = 900;
/** Height of a zone name written at its zone, for the check whether a plate covers it. */
const LABEL_PX = 16;
const MAX_TRAVELLERS = 5;

type BadgeKind = "normal" | "tv" | "compact";

/**
 * Plate sizes in pixels, fixed so the spreading knows them; the truck and the figure are sized to fit. Normal and TV
 * plates carry the zone's name on top, since a plate covers the name written at the zone; the phone map has no names.
 */
const BADGES: Record<BadgeKind, { width: number; height: number; caption: string | null; truck: string; count: string; mark: string; traveller: string }> = {
  normal: { width: 116, height: 56, caption: "text-[11px] leading-[14px]", truck: "h-6 w-12", count: "text-[26px]", mark: "size-[22px] -top-2.5 -right-2.5", traveller: "h-5 w-10" },
  tv: { width: 164, height: 82, caption: "text-[15px] leading-5", truck: "h-[34px] w-[68px]", count: "text-[38px]", mark: "size-8 -top-3.5 -right-3.5", traveller: "h-7 w-14" },
  compact: { width: 60, height: 30, caption: null, truck: "h-4 w-8", count: "text-[17px]", mark: "size-4 -top-2 -right-2", traveller: "h-3.5 w-7" },
};

export interface PlantMapProps {
  state: ControlRoomState;
  plan: Pick<PlanDrawing, "markup" | "imageUrl" | "backdrop">;
  now: Date;
  tv?: boolean;
  /** Opens a zone's plate list; without it the plates are not buttons (the wall screen). */
  onZone?: (code: string, anchor: HTMLElement) => void;
  /** The zone whose list is open, for aria-expanded. */
  openZone?: string | null;
}

/** Fill strength of the zones: stronger over the picture, which has its own colours and lines. */
const ZONE_FILL = { image: 0.42, svg: 0.26 };
/** The dark-theme treatment of the picture (see the note at the top). */
const DARK_PICTURE = "dark:[filter:invert(1)_hue-rotate(180deg)_brightness(0.92)_contrast(0.82)]";

interface Travel {
  key: number;
  moves: Move[];
  /** The trucks the map shows once the pictures have arrived. */
  target: ControlRoomTruck[];
}

/**
 * The trucks the map shows: the live list, except while pictures travel, when the counts stay as they were until
 * they arrive. A new list during a travel restarts it from what the map shows towards the newest list.
 */
function useTravel(trucks: ControlRoomTruck[], reduceMotion: boolean) {
  const [shown, setShown] = useState(trucks);
  const [seen, setSeen] = useState(trucks);
  const [travel, setTravel] = useState<Travel | null>(null);

  // derived from the previous render, not in an effect: the new list and its moves are known while rendering
  if (trucks !== seen) {
    setSeen(trucks);
    const { moves } = reduceMotion ? { moves: [] } : detectMoves(shown, trucks, MAX_TRAVELLERS);
    if (moves.length === 0) {
      setShown(trucks);
      setTravel(null);
    } else {
      setTravel({ key: (travel?.key ?? 0) + 1, moves, target: trucks });
    }
  }

  useEffect(() => {
    if (!travel) return;
    const timer = setTimeout(() => {
      setShown(travel.target);
      setTravel(null);
    }, TRAVEL_MS);
    return () => clearTimeout(timer);
  }, [travel]);

  return { shown, travel };
}

export function PlantMap({ state, plan, now, tv = false, onZone, openZone = null }: PlantMapProps) {
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
  const kind: BadgeKind = tv ? "tv" : compact ? "compact" : "normal";
  const badge = BADGES[kind];
  const interactive = !tv && !!onZone;

  const { shown, travel } = useTravel(state.trucks, reduceMotion);
  const groups = useMemo(() => groupTrucksByZone(state.zones, shown, now), [state.zones, shown, now]);

  // centre of each zone's box in pixels, and where the plates of the zones with trucks stand after spreading
  const { centres, places } = useMemo(() => {
    const centreOf = new Map<string, Point>();
    for (const zone of state.zones) {
      const box = shapeBox(zone.shape);
      if (box) centreOf.set(zone.code, { x: (box.x + box.width / 2) * size.width, y: (box.y + box.height / 2) * size.height });
    }
    if (size.width === 0) return { centres: centreOf, places: new Map<string, Point>() };
    const occupied = groups.filter((group) => group.count > 0 && centreOf.has(group.code)).map((group) => ({ code: group.code, ...centreOf.get(group.code)! }));
    return { centres: centreOf, places: spreadBadges(occupied, badge, size) };
  }, [state.zones, groups, size, badge]);

  const percent = (point: Point) => ({ left: `${(point.x / Math.max(size.width, 1)) * 100}%`, top: `${(point.y / Math.max(size.height, 1)) * 100}%` });

  return (
    <div ref={frame} className="relative w-full" style={{ aspectRatio: `${aspect.width} / ${aspect.height}` }} data-testid="plant-map">
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

      {/* names of the zones without a plate, above the zone or, when a plate covers that spot, below it; a narrow
          map leaves them to the list under it */}
      {size.width > 0 && !compact
        ? state.zones.map((zone) => {
            const box = shapeBox(zone.shape);
            if (!box || places.has(zone.code)) return null;
            const name = shortZoneName(zone);
            const width = Math.min(name.length * (tv ? 9 : 6.2), Math.max(box.width, 0.09) * size.width);
            const covered = (left: number, top: number) =>
              [...places.values()].some(
                (place) =>
                  left < place.x + badge.width / 2 && place.x - badge.width / 2 < left + width && top < place.y + badge.height / 2 && place.y - badge.height / 2 < top + LABEL_PX,
              );
            // top left as before; top right, then below, when a plate stands on that spot
            const top = box.y * size.height - LABEL_PX;
            const spot = !covered(box.x * size.width, top)
              ? "left"
              : !covered((box.x + box.width) * size.width - width, top)
                ? "right"
                : !covered(box.x * size.width, (box.y + box.height) * size.height)
                  ? "below"
                  : "left";
            return (
              <span
                key={zone.code}
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute z-20 truncate font-medium leading-none text-foreground/85 [text-shadow:0_0_3px_var(--background),0_0_6px_var(--background)]",
                  spot === "below" ? "pt-0.5" : "-translate-y-full pb-0.5",
                  spot === "right" && "-translate-x-full",
                  tv ? "text-sm" : "text-[0.6875rem]",
                )}
                style={{
                  left: `${(spot === "right" ? box.x + box.width : box.x) * 100}%`,
                  top: `${(spot === "below" ? box.y + box.height : box.y) * 100}%`,
                  maxWidth: `${Math.max(box.width * 100, 9)}%`,
                }}
              >
                {name}
              </span>
            );
          })
        : null}

      {/* one plate per zone with trucks: the truck picture and the count */}
      {groups.map((group) => {
        const place = places.get(group.code);
        if (!place || group.count === 0) return null;
        const label = zoneLabel(group);
        const content = (
          <>
            <span aria-hidden="true" className="absolute inset-y-1.5 left-1.5 w-1 rounded-full" style={{ background: group.color ?? "var(--muted-foreground)" }} />
            {badge.caption ? (
              <span aria-hidden="true" className={cn("block w-full truncate text-left font-medium text-muted-foreground", badge.caption)}>
                {group.name}
              </span>
            ) : null}
            <span className={cn("flex items-center justify-center", kind === "tv" ? "gap-2.5" : kind === "compact" ? "gap-1" : "gap-2")}>
              <TruckPicture className={badge.truck} />
              <span aria-hidden="true" className={cn("display leading-none font-bold text-foreground tabular-nums", badge.count)}>
                {group.count}
              </span>
            </span>
            {group.longWait ? <LongWaitMark className={cn("absolute", badge.mark)} /> : null}
          </>
        );
        const common = {
          "data-zone-badge": group.code,
          "data-count": group.count,
          "data-held": group.held ? "true" : undefined,
          "data-long": group.longWait ? "true" : undefined,
          className: cn(
            "absolute z-30 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-xl border border-line-strong bg-card shadow-raised",
            kind === "tv" ? "gap-1 rounded-2xl pr-2 pl-4" : kind === "compact" ? "rounded-lg pl-2" : "gap-0.5 pr-1.5 pl-3.5",
            group.held && (kind === "compact" ? "ring-2 ring-signal" : "ring-3 ring-signal"),
            !reduceMotion && "transition-[left,top] duration-500 ease-out",
          ),
          style: { ...percent(place), width: badge.width, height: badge.height },
        };
        return interactive ? (
          <button
            key={group.code}
            type="button"
            {...common}
            className={cn(
              common.className,
              "outline-none hover:border-ring focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-ring",
              openZone === group.code && "border-ring",
            )}
            aria-label={label}
            aria-haspopup="dialog"
            aria-expanded={openZone === group.code}
            onClick={(event) => onZone?.(group.code, event.currentTarget)}
          >
            {content}
          </button>
        ) : (
          <div key={group.code} role="img" aria-label={label} {...common}>
            {content}
          </div>
        );
      })}

      {/* trucks on their way to another zone */}
      {travel && size.width > 0
        ? travel.moves.map((move) => {
            const from = places.get(move.from) ?? centres.get(move.from);
            const to = places.get(move.to) ?? centres.get(move.to);
            if (!from || !to) return null;
            return (
              <motion.div
                key={`${travel.key}-${move.tripId}`}
                aria-hidden="true"
                data-traveller={move.tripId}
                className="pointer-events-none absolute top-0 left-0 z-40"
                initial={{ x: from.x, y: from.y }}
                animate={{ x: to.x, y: to.y }}
                transition={{ duration: TRAVEL_MS / 1000, ease: "easeInOut" }}
              >
                <span className="flex -translate-x-1/2 -translate-y-1/2 rounded-md border border-line-strong bg-card p-1 shadow-raised">
                  <TruckPicture className={badge.traveller} />
                </span>
              </motion.div>
            );
          })
        : null}
    </div>
  );
}
