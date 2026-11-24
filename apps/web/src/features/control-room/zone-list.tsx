"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { LongWaitMark } from "@/features/control-room/truck-picture";
import { formatWait, HELD_LABELS, LONG_WAIT_MINUTES } from "@/lib/control-room";
import { listMode, placePopover, type ZoneGroup, type ZoneTruckRow } from "@/lib/control-room-map";
import { cn } from "@/lib/utils";

// The plates in one zone, opened from the zone's plate on the map or its row in the Zona panel: longest wait first,
// each row with the plate, direction, step, minutes in the zone and a mark when held. A row opens the truck detail
// window. On wide screens a popover at the zone that stays inside the viewport; under 640 px a sheet from the bottom.
// Escape and a click outside close it, and the focus goes back to the zone.

const subscribeResize = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const readWidth = () => window.innerWidth;

/** What the truck is doing: "Menunggu timbang 1", "Sedang bongkar", or what a held truck waits for. */
export function stepText(row: ZoneTruckRow): string {
  const { truck } = row;
  if (truck.held) return HELD_LABELS[truck.held.type] ?? "Ditahan";
  if (!truck.stepName) return "Baru masuk";
  return `${truck.stepStatus === "IN_PROGRESS" ? "Sedang" : "Menunggu"} ${truck.stepName.charAt(0).toLowerCase()}${truck.stepName.slice(1)}`;
}

function PlateRows({ group, onTrip }: { group: ZoneGroup; onTrip: (tripId: number, row: HTMLElement) => void }) {
  if (group.trucks.length === 0) return <p className="px-4 py-3 text-sm text-muted-foreground">Tidak ada truk di zona ini sekarang.</p>;
  return (
    <ul className="space-y-0.5 p-1.5" data-testid="zone-list-rows">
      {group.trucks.map((row) => {
        const incoming = row.truck.direction === "IN";
        return (
          <li key={row.truck.tripId}>
            <button
              type="button"
              data-trip={row.truck.tripId}
              onClick={(event) => onTrip(row.truck.tripId, event.currentTarget)}
              aria-label={`${row.truck.plateDisplay ?? "Tanpa plat"}, ${incoming ? "incoming" : "outgoing"}, ${stepText(row)}, ${formatWait(row.minutes)} di zona ini${row.held ? ", ditahan" : ""}. Buka detail truk.`}
              className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="plate text-[0.8125rem]">{row.truck.plateDisplay ?? "?"}</span>
              <span className="min-w-0">
                <span className={cn("line-clamp-2 text-sm leading-snug", row.held && "font-medium text-signal-ink")}>{stepText(row)}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span aria-hidden="true" className={cn("size-2 rounded-full", incoming ? "bg-stream-in" : "bg-stream-out")} />
                  {incoming ? "Incoming" : "Outgoing"}
                  {row.held ? (
                    <span className="ml-1 rounded-full bg-signal px-1.5 text-[0.6875rem] leading-4 font-semibold text-signal-foreground">Ditahan</span>
                  ) : null}
                </span>
              </span>
              <span className={cn("flex items-center gap-1 text-sm font-medium tabular-nums", row.long ? "text-warning" : "text-muted-foreground")}>
                {row.long ? <LongWaitMark className="size-3.5" /> : null}
                {formatWait(row.minutes)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function ListHeading({ group }: { group: ZoneGroup }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="size-3 shrink-0 rounded-[3px] ring-1 ring-foreground/15" style={{ background: group.color ?? "var(--muted)" }} />
      <span className="truncate">{group.name}</span>
    </span>
  );
}

function countText(group: ZoneGroup) {
  const held = group.trucks.filter((row) => row.held).length;
  const long = group.trucks.filter((row) => row.long).length;
  return [`${group.count} truk, terlama di atas`, held ? `${held} menunggu keputusan` : null, long ? `${long} lebih dari ${LONG_WAIT_MINUTES} menit` : null]
    .filter(Boolean)
    .join(" · ");
}

export interface ZoneListProps {
  group: ZoneGroup;
  anchor: HTMLElement;
  /** The truck detail window is open over the list: Escape and outside clicks belong to it. */
  suspended: boolean;
  onClose: () => void;
  onTrip: (tripId: number, row: HTMLElement) => void;
}

/** The plate list of one zone: a popover at the zone on wide screens, a bottom sheet on narrow ones. */
export function ZoneList(props: ZoneListProps) {
  const width = useSyncExternalStore(subscribeResize, readWidth, () => 1024);
  return listMode(width) === "sheet" ? <ZoneSheet {...props} /> : <ZonePopover {...props} />;
}

function ZoneSheet({ group, anchor, onClose, onTrip }: ZoneListProps) {
  return (
    <Sheet open onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent
        side="bottom"
        className="max-h-[78dvh] gap-0 rounded-t-3xl p-0"
        data-testid="zone-list"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (anchor.isConnected) anchor.focus();
        }}
      >
        <SheetHeader className="border-b px-5 pt-5 pb-3">
          <SheetTitle className="text-base">
            <ListHeading group={group} />
          </SheetTitle>
          <SheetDescription>{countText(group)}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 overflow-y-auto pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <PlateRows group={group} onTrip={onTrip} />
        </div>
      </SheetContent>
    </Sheet>
  );
}

const POPOVER_WIDTH = 400;

function ZonePopover({ group, anchor, suspended, onClose, onTrip }: ZoneListProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  // placed after layout, again when the zone's plate moves, the page scrolls or the window changes size
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const measure = () => {
      const rect = anchor.getBoundingClientRect();
      const placed = placePopover(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        { width: element.offsetWidth, height: element.offsetHeight },
        { width: document.documentElement.clientWidth, height: window.innerHeight },
      );
      setPlace((current) => (current && current.left === placed.left && current.top === placed.top ? current : { left: placed.left, top: placed.top }));
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer.disconnect();
    };
  }, [anchor, group]);

  // the first plate takes the focus once the list is placed (it is hidden, and cannot take it, until then)
  const placed = place !== null;
  const focused = useRef(false);
  useEffect(() => {
    if (!placed || focused.current) return;
    focused.current = true;
    const first = panel.current?.querySelector<HTMLElement>("button[data-trip]") ?? panel.current?.querySelector<HTMLElement>("button");
    first?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    if (suspended) return;
    const close = (returnFocus: boolean) => {
      onClose();
      if (returnFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    };
    const onKey = (event: KeyboardEvent) => {
      // the detail window closes on Escape synchronously, so this listener is back during that same keydown; the
      // window marks the key as used
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close(true);
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || panel.current?.contains(target)) return;
      // a click on the zone's own plate toggles it; the plate's click handler closes the list
      if (anchor.contains(target)) return;
      close(!(target instanceof Element && target.closest("button, a, input, select, textarea, [tabindex]")));
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [suspended, onClose, anchor]);

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={`${group.name}, ${group.count} truk`}
      data-testid="zone-list"
      className="fixed z-50 flex max-h-[min(28rem,70vh)] flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-overlay"
      style={{ width: `min(${POPOVER_WIDTH}px, calc(100vw - 24px))`, left: place?.left ?? -9999, top: place?.top ?? 0, visibility: place ? "visible" : "hidden" }}
    >
      <div className="flex items-start justify-between gap-3 border-b px-4 pt-3 pb-2.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            <ListHeading group={group} />
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{countText(group)}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="-mt-1 -mr-2 size-8"
          onClick={() => {
            onClose();
            if (anchor.isConnected) anchor.focus({ preventScroll: true });
          }}
        >
          <X aria-hidden="true" />
          <span className="sr-only">Tutup daftar</span>
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <PlateRows group={group} onTrip={onTrip} />
      </div>
    </div>,
    document.body,
  );
}
