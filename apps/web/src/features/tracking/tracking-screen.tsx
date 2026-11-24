"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { MapPinOff, X } from "lucide-react";

import { FilterChips } from "@/components/filter-chips";
import { AccessDenied, ListEmpty, ListError, Notice, PageHeader, ResultCount, SearchField } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/features/auth/auth-provider";
import { TrackingTabs, TruckStateBadge } from "@/features/tracking/parts";
import { TruckMap } from "@/features/tracking/truck-map";
import { useApiQuery } from "@/hooks/use-api-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useUrlFilter } from "@/hooks/use-url-filter";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { formatDateTime, formatNumber } from "@/lib/format";
import {
  accuracyText,
  agoText,
  directionText,
  distanceText,
  filterByState,
  findSelected,
  parseSelection,
  parseStateFilter,
  selectionSearch,
  sourceText,
  speedText,
  STATE_FILTERS,
  stateCounts,
  trackRequest,
  tripLine,
  truckState,
  type GpsTrack,
  type GpsVehicleItem,
  type GpsVehicleList,
  type MapSelection,
  type StateFilter,
} from "@/lib/gps";
import { canManageGps, canTrackVehicles, isStaff } from "@/lib/permissions";
import { api } from "@/lib/session";
import { cn } from "@/lib/utils";

const REFRESH_MS = 15_000;
const LIST_LIMIT = 500;
const NO_SELECTION: MapSelection = { vehicle: null, trip: null };

function Fact({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm wrap-break-word">{children}</dd>
    </div>
  );
}

/** The selected truck: its trip, its last point, and how much of its track is drawn. */
function TruckPanel({
  row,
  now,
  trackText,
  onClose,
}: {
  row: GpsVehicleItem;
  now: number;
  trackText: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const { trip, last } = row;
  const distance = distanceText(row.distanceToPlantKm);
  const numbers = trip ? [...trip.doNos, ...trip.contractNos] : [];
  return (
    <section aria-labelledby={titleId} className="rounded-2xl border bg-card p-4 shadow-panel" data-testid="gps-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="kicker text-muted-foreground">Truk terpilih</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h2 id={titleId} className="plate text-lg">
              {row.vehicle.plateDisplay}
            </h2>
            <TruckStateBadge state={truckState(last, now)} />
          </div>
        </div>
        <Button variant="ghost" size="icon" className="-mr-1 -mt-1 shrink-0" onClick={onClose} aria-label="Tutup rincian truk">
          <X aria-hidden="true" />
        </Button>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact label="Perjalanan" wide>
          {trip ? <span className="ident">{trip.tripNo ?? trip.spjNo ?? "Belum check-in"}</span> : "Tidak sedang dalam perjalanan"}
        </Fact>
        {trip ? <Fact label="Arah">{directionText(trip.direction)}</Fact> : null}
        {trip ? <Fact label="Mitra">{trip.partner?.name ?? "-"}</Fact> : null}
        {trip ? (
          <Fact label="DO atau kontrak" wide>
            <span className="ident">{numbers.length > 0 ? numbers.join(", ") : "-"}</span>
          </Fact>
        ) : null}
        <Fact label="Titik terakhir">
          {formatDateTime(last.at)}
          <span className="block text-xs text-muted-foreground">{agoText(last.at, now)}</span>
        </Fact>
        <Fact label="Kecepatan">{speedText(last.speedKph)}</Fact>
        <Fact label="Ketelitian">{accuracyText(last.accuracyM)}</Fact>
        <Fact label="Sumber">{sourceText(last.sourceKind)}</Fact>
        {distance ? <Fact label="Jarak ke pabrik">{distance}</Fact> : null}
        {row.vehicle.owner ? <Fact label="Pemilik">{row.vehicle.owner.name}</Fact> : null}
      </dl>
      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground" data-testid="gps-track-text">
        {trackText}
      </p>
    </section>
  );
}

function TruckRow({ row, now, selected, onSelect }: { row: GpsVehicleItem; now: number; selected: boolean; onSelect: () => void }) {
  const distance = distanceText(row.distanceToPlantKm);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        data-testid="gps-row"
        data-vehicle-id={String(row.vehicle.id)}
        className={cn(
          "w-full rounded-xl border bg-card px-3.5 py-3 text-left outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-ring/50",
          selected ? "border-primary/60 bg-accent/40 shadow-[inset_3px_0_0_var(--primary)]" : "hover:border-line-strong hover:bg-muted/50",
        )}
      >
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="plate text-[0.8125rem]">{row.vehicle.plateDisplay}</span>
          <TruckStateBadge state={truckState(row.last, now)} />
        </span>
        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
          <span>{agoText(row.last.at, now)}</span>
          <span>{speedText(row.last.speedKph)}</span>
          {distance ? <span>{distance} dari pabrik</span> : null}
        </span>
        <span className={cn("mt-1 block truncate text-sm", row.trip ? "text-foreground" : "text-muted-foreground")}>
          {row.trip ? tripLine(row.trip) : "Tidak sedang dalam perjalanan"}
        </span>
      </button>
    </li>
  );
}

function MapSkeleton() {
  return (
    <div aria-busy="true" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_23rem]">
      <span className="sr-only" role="status">
        Memuat posisi truk
      </span>
      <Skeleton className="h-[48dvh] min-h-72 rounded-2xl lg:h-[calc(100dvh-22rem)] lg:min-h-112" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/** Lacak kendaraan: the trucks with a position on a road map, a list beside it, and the selected truck's track. */
export function TrackingScreen() {
  const { state } = useAuth();
  const user = state.status === "authenticated" ? state.user : null;
  const mayView = canTrackVehicles(user);
  const mayManage = canManageGps(user);
  const ids = useId();

  const [searchText, setSearchText] = useUrlFilter("q");
  const [stateText, setStateText] = useUrlFilter("keadaan");
  const filter = parseStateFilter(stateText);
  const search = useDebouncedValue(searchText.trim(), 300);
  // from the router, not window.location: after a client-side link the address bar changes after the first render
  const searchParams = useSearchParams();
  const [selection, setSelection] = useState<MapSelection>(() => parseSelection(searchParams.toString()));
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  // a selection that can be linked to: ?vehicle= or ?trip=
  useEffect(() => {
    const url = new URL(window.location.href);
    url.search = selectionSearch(url.search, selection);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }, [selection]);

  useVisibleInterval(
    () => {
      setNow(Date.now());
      setTick((value) => value + 1);
    },
    REFRESH_MS,
    mayView,
  );

  const list = useApiQuery(
    mayView ? `${search}|${tick}` : null,
    (signal) => api.request<GpsVehicleList>("/api/gps/vehicles", { query: { q: search, limit: LIST_LIMIT }, signal }),
    { keepPrevious: true },
  );

  const items = list.data?.items ?? [];
  const selected = findSelected(items, selection);
  const selectedId = selected ? String(selected.vehicle.id) : null;
  // a trip link whose truck is not in the list: its own track may still say where it went
  const orphanTrip = selection.trip !== null && list.data !== undefined && selected === null ? selection.trip : null;
  const plan = selected
    ? trackRequest(selected, now)
    : orphanTrip
      ? { path: `/api/gps/trips/${encodeURIComponent(orphanTrip)}/track`, query: {}, label: "" }
      : null;
  const track = useApiQuery(
    plan ? `${plan.path}|${tick}` : null,
    async (signal) => ({ path: plan?.path ?? "", track: await api.request<GpsTrack>(plan?.path ?? "", { query: plan?.query, signal }) }),
    { keepPrevious: true },
  );
  // a previous truck's track is never drawn under the next one
  const trackData = plan && track.data?.path === plan.path ? track.data.track : null;

  const shown = filterByState(items, filter, now);
  const counts = list.data ? stateCounts(items, now) : undefined;
  const moving = counts?.bergerak ?? 0;

  function choose(row: GpsVehicleItem) {
    setSelection({ vehicle: String(row.vehicle.id), trip: null });
  }

  if (!user) return null;
  if (!mayView) return <AccessDenied module="gps" />;

  const trackText = !plan
    ? ""
    : track.hasError && !trackData
      ? "Jejak belum bisa dimuat."
      : !trackData
        ? "Memuat jejak"
        : trackData.points.length === 0
          ? `${plan.label}: belum ada titik.`
          : `${plan.label}: ${formatNumber(trackData.total)} titik${trackData.thinned ? `, ${formatNumber(trackData.points.length)} digambar` : ""}.`;

  const orphanText =
    orphanTrip && (track.hasError || (trackData && trackData.points.length === 0))
      ? "Truk untuk perjalanan ini belum punya posisi. Posisinya muncul setelah alat pelacak truk mengirim data atau supir membagikan lokasi dari QR di SPJ."
      : orphanTrip && trackData && trackData.points.length > 0
        ? "Truk perjalanan ini tidak ada di daftar sekarang. Jejak perjalanannya digambar di peta."
        : null;
  const missingVehicle = selection.vehicle !== null && selection.trip === null && list.data !== undefined && selected === null && !search;

  const nothingTracked = list.data !== undefined && list.data.total === 0 && !search;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Lacak kendaraan"
        figures={
          list.data ? (
            <>
              <span>
                <span className="font-semibold text-foreground tabular-nums">{formatNumber(list.data.total)}</span> truk dengan posisi
              </span>
              <span>
                <span className="font-semibold text-foreground tabular-nums">{formatNumber(moving)}</span> bergerak
              </span>
            </>
          ) : null
        }
        description="Posisi truk di luar pabrik dari alat pelacak dan ponsel supir. Diperbarui tiap 15 detik selama halaman ini terbuka."
      >
        {mayManage ? <TrackingTabs current="map" /> : null}
      </PageHeader>

      {nothingTracked ? null : (
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <SearchField id={`${ids}-search`} label="Cari truk" placeholder="Nomor plat" value={searchText} onChange={setSearchText} />
          <FilterChips<StateFilter>
            label="Saring menurut keadaan truk"
            caption="Keadaan"
            filters={STATE_FILTERS}
            selected={filter}
            counts={counts}
            onSelect={setStateText}
          />
        </div>
      )}

      {list.hasError && !list.data ? (
        <ListError title="Posisi truk belum bisa dimuat" error={list.error} onRetry={list.reload} />
      ) : !list.data ? (
        <MapSkeleton />
      ) : nothingTracked ? (
        <ListEmpty
          title="Belum ada truk yang mengirim posisi"
          hint={
            isStaff(user)
              ? "Truk muncul di peta setelah alat pelacaknya dipasang di Pengaturan GPS, atau setelah supir membuka tautan Bagikan lokasi dari QR di SPJ."
              : "Truk Anda muncul di sini setelah alat pelacaknya mengirim posisi, atau setelah supir membuka tautan Bagikan lokasi dari QR di SPJ."
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_23rem]">
          <TruckMap
            items={shown}
            now={now}
            selectedId={selectedId}
            track={trackData?.points ?? null}
            onSelect={(id) => setSelection({ vehicle: id, trip: null })}
            className="h-[52dvh] min-h-72 overflow-hidden rounded-2xl border shadow-panel lg:h-[calc(100dvh-22rem)] lg:min-h-112"
          />
          <div className="flex min-w-0 flex-col gap-3 lg:max-h-[calc(100dvh-22rem)] lg:min-h-112">
            {list.hasError ? <Notice tone="warning">Posisi terbaru belum bisa dimuat. Yang tampil adalah data sebelumnya.</Notice> : null}
            {selected ? (
              <TruckPanel row={selected} now={now} trackText={trackText} onClose={() => setSelection(NO_SELECTION)} />
            ) : orphanText || missingVehicle ? (
              <div className="flex items-start gap-3 rounded-2xl border border-dashed border-line-strong bg-card p-4 text-sm" data-testid="gps-no-position">
                <MapPinOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <p className="flex-1">{orphanText ?? "Kendaraan ini belum punya posisi yang bisa Anda lihat."}</p>
                <Button variant="ghost" size="sm" onClick={() => setSelection(NO_SELECTION)}>
                  Tutup
                </Button>
              </div>
            ) : null}
            {shown.length === 0 ? (
              <ListEmpty
                title="Tidak ada truk yang cocok"
                hint={search ? "Periksa lagi nomor plat yang dicari." : "Pilih Semua untuk melihat semua truk."}
                stale={list.isStale}
              />
            ) : (
              <>
                <ResultCount shown={shown.length} total={filter === "" ? list.data.total : shown.length} noun="truk" />
                <ul aria-label="Daftar truk" className={cn("flex flex-col gap-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:pr-1", list.isStale && "opacity-70")}>
                  {shown.map((row) => (
                    <TruckRow key={String(row.vehicle.id)} row={row} now={now} selected={String(row.vehicle.id) === selectedId} onSelect={() => choose(row)} />
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
