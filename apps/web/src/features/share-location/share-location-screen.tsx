"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useParams } from "next/navigation";
import { CircleAlert, CircleCheck, Link2Off, Loader2, LockKeyhole, MapPinOff, Navigation, RefreshCw, Smartphone, Square } from "lucide-react";

import { AppMark } from "@/components/app-mark";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/hooks/use-api-query";
import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { useLocationShare } from "@/features/share-location/use-location-share";
import { isApiError } from "@/lib/api-client";
import { formatDateTime, formatNumber } from "@/lib/format";
import { accuracyText, agoText, destinationText, shareScreen, type ShareLink } from "@/lib/gps";
import { googleMapsUrl } from "@/lib/location";
import { api } from "@/lib/session";
import { cn } from "@/lib/utils";

const noSubscribe = () => () => {};
const isSecure = () => window.isSecureContext;
const hasGeolocation = () => typeof navigator.geolocation?.watchPosition === "function";

const timeOf = (ms: number | null) => (ms === null ? "-" : formatDateTime(new Date(ms).toISOString()).split(" ").at(-1) ?? "-");

function Plain({ icon: Icon, tone = "neutral", title, children, testId, main = false }: { icon: typeof CircleAlert; tone?: "neutral" | "error"; title: string; children: ReactNode; testId: string; main?: boolean }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-panel" data-testid={testId}>
      <span
        aria-hidden="true"
        className={cn("flex size-11 items-center justify-center rounded-xl border bg-surface", tone === "error" ? "border-destructive/30 text-destructive" : "text-muted-foreground")}
      >
        <Icon className="size-5" />
      </span>
      {main ? <h1 className="text-xl leading-tight font-semibold">{title}</h1> : <h2 className="text-xl leading-tight font-semibold">{title}</h2>}
      <div className="flex flex-col gap-3 text-[0.9375rem] leading-relaxed text-pretty text-muted-foreground">{children}</div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2.5 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right text-[0.9375rem] font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * The page the QR code on the SPJ opens. Public, made for a phone: the driver shares the phone's location for this
 * one trip while the page stays open.
 */
export function ShareLocationScreen() {
  const { token } = useParams<{ token: string }>();
  const secure = useSyncExternalStore(noSubscribe, isSecure, () => true);
  const geolocation = useSyncExternalStore(noSubscribe, hasGeolocation, () => true);
  const link = useApiQuery(`share|${token}`, (signal) => api.request<ShareLink>(`/api/gps/share/${encodeURIComponent(token)}`, { auth: false, signal }));
  const share = useLocationShare(token);
  const [now, setNow] = useState(() => Date.now());
  useVisibleInterval(() => setNow(Date.now()), 5000, share.state.sharing);

  const linkState =
    share.state.unknown || (link.hasError && isApiError(link.error) && link.error.status === 404)
      ? "unknown"
      : link.hasError
        ? "error"
        : !link.data
          ? "loading"
          : share.state.closed || !link.data.open
            ? "closed"
            : "open";
  const screen = shareScreen({ link: linkState, secure, geolocation, denied: share.state.denied, sharing: share.state.sharing });
  const plate = link.data?.plateDisplay ?? null;
  const { state } = share;

  return (
    <main className="min-h-dvh bg-background px-4 pt-5 pb-10">
      <div className="mx-auto flex w-full max-w-md flex-col gap-5">
        <header className="flex items-center justify-between gap-3">
          <AppMark />
          <ThemeToggle />
        </header>

        {screen === "loading" ? (
          <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Memuat tautan
          </p>
        ) : screen === "unknown" ? (
          <Plain icon={Link2Off} title="Tautan tidak dikenal" testId="share-unknown" main>
            <p>Tautan ini tidak ada atau sudah diganti. Pindai lagi QR Bagikan lokasi di SPJ terbaru, atau tanyakan ke petugas pos registrasi.</p>
          </Plain>
        ) : screen === "error" ? (
          <Plain icon={CircleAlert} tone="error" title="Halaman belum bisa dimuat" testId="share-error" main>
            <p>Periksa sinyal internet ponsel, lalu coba lagi.</p>
            <Button variant="secondary" className="w-fit" onClick={link.reload}>
              <RefreshCw aria-hidden="true" />
              Coba lagi
            </Button>
          </Plain>
        ) : (
          <>
            <section className="flex flex-col gap-3">
              <p className="kicker text-primary-ink">Bagikan lokasi</p>
              <h1 className="flex flex-wrap items-center gap-x-3 gap-y-2 text-2xl leading-tight font-semibold">
                Truk <span className="plate text-[1.375rem]" data-testid="share-plate">{plate ?? "-"}</span>
              </h1>
              {screen !== "closed" ? (
                <div className="flex flex-col gap-2 text-[0.9375rem] leading-relaxed text-pretty" data-testid="share-explainer">
                  <p className="text-muted-foreground">
                    Halaman ini mengirim lokasi ponsel Anda selama perjalanan truk ini, hanya selama halaman tetap terbuka. Lokasinya dilihat petugas
                    pabrik, pemilik truk, dan mitra yang mengirim atau menerima muatan ini.
                  </p>
                  <p className="font-medium">Berlaku: {link.data?.until}</p>
                  {(link.data?.destinations ?? []).map((place) => (
                    <p key={String(place.deliveryOrderId)} className="flex flex-wrap items-baseline gap-x-2" data-testid="share-destination">
                      <span>
                        Tujuan: <span className="font-medium">{destinationText(place)}</span>
                      </span>
                      <a
                        href={googleMapsUrl(place)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-10 items-center font-medium text-primary-ink underline underline-offset-4"
                      >
                        Buka di peta
                      </a>
                    </p>
                  ))}
                </div>
              ) : null}
            </section>

            {screen === "closed" ? (
              <Plain icon={CircleCheck} title="Berbagi lokasi sudah ditutup" testId="share-closed">
                <p>Perjalanan ini sudah selesai atau tautannya dicabut, jadi lokasi tidak dikirim lagi. Halaman ini boleh ditutup.</p>
              </Plain>
            ) : screen === "insecure" ? (
              <Plain icon={LockKeyhole} title="Halaman harus dibuka lewat HTTPS" testId="share-insecure">
                <p>Browser hanya memberi lokasi pada halaman yang alamatnya diawali https:// (atau localhost). Alamat halaman ini tidak begitu.</p>
                <p>Tunjukkan layar ini ke petugas pos registrasi supaya alamat tautan di SPJ diperbaiki.</p>
              </Plain>
            ) : screen === "unsupported" ? (
              <Plain icon={Smartphone} title="Browser ini tidak bisa memberi lokasi" testId="share-unsupported">
                <p>Buka tautan ini di Chrome atau Safari versi terbaru. Bila QR dibuka dari aplikasi lain, pilih Buka di browser.</p>
              </Plain>
            ) : screen === "denied" ? (
              <Plain icon={MapPinOff} title="Izin lokasi ditolak" testId="share-denied">
                <p>Tanpa izin lokasi, posisi truk tidak bisa dikirim. Cara mengizinkan:</p>
                <ol className="list-decimal pl-5 text-foreground">
                  <li>Ketuk ikon gembok atau ikon pengaturan di sebelah alamat halaman.</li>
                  <li>Pilih Izin atau Lokasi, lalu ubah menjadi Izinkan.</li>
                  <li>Muat ulang halaman ini dan ketuk Bagikan lokasi.</li>
                </ol>
                <p>Bila tetap tidak bisa, nyalakan Lokasi (GPS) di pengaturan ponsel.</p>
                <Button variant="secondary" className="w-fit" onClick={() => window.location.reload()}>
                  <RefreshCw aria-hidden="true" />
                  Muat ulang
                </Button>
              </Plain>
            ) : screen === "sharing" ? (
              <section className="flex flex-col gap-4 rounded-2xl border border-success/30 bg-card p-5 shadow-panel" data-testid="share-active" aria-live="polite">
                <p className="flex items-center gap-2.5 text-base font-semibold text-success">
                  <span aria-hidden="true" className="relative flex size-3">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-40 motion-reduce:hidden" />
                    <span className="relative inline-flex size-3 rounded-full bg-success" />
                  </span>
                  Lokasi sedang dibagikan
                </p>
                <dl>
                  <Fact label="Aktif sejak">{timeOf(state.startedAt)}</Fact>
                  <Fact label="Terakhir terkirim">
                    <span data-testid="share-last-sent">{state.lastSentAt === null ? "belum ada" : `${timeOf(state.lastSentAt)} (${agoText(new Date(state.lastSentAt).toISOString(), now)})`}</span>
                  </Fact>
                  <Fact label="Ketelitian">{state.lastFix ? accuracyText(state.lastFix.accuracyM) : "-"}</Fact>
                  {state.waiting > 0 ? <Fact label="Menunggu sinyal">{formatNumber(state.waiting)} titik</Fact> : null}
                </dl>
                {state.searching ? <p className="text-sm text-warning">Mencari lokasi. Pastikan GPS ponsel menyala dan ponsel tidak tertutup.</p> : null}
                {state.offline ? <p className="text-sm text-warning">Sinyal internet putus. Titik disimpan dulu dan dikirim saat sinyal kembali.</p> : null}
                {state.dropped > 0 ? <p className="text-sm text-muted-foreground">{formatNumber(state.dropped)} titik lama dibuang karena terlalu lama tanpa sinyal.</p> : null}
                <p className="text-sm text-muted-foreground">
                  {state.wakeLock === "on"
                    ? "Layar dijaga tetap menyala. Biarkan halaman ini terbuka selama perjalanan."
                    : "Biarkan layar tetap menyala dan halaman ini terbuka. Bila layar mati atau halaman ditutup, lokasi berhenti terkirim."}
                </p>
                <Button variant="outline" size="lg" className="h-12 w-full" onClick={share.stop}>
                  <Square aria-hidden="true" />
                  Berhenti
                </Button>
              </section>
            ) : (
              <section className="flex flex-col gap-3" data-testid="share-ready">
                <Button size="lg" className="h-16 w-full rounded-2xl text-lg" onClick={share.start}>
                  <Navigation className="size-5" aria-hidden="true" />
                  Bagikan lokasi
                </Button>
                <p className="text-sm text-muted-foreground">Browser akan meminta izin lokasi. Pilih Izinkan. Anda bisa berhenti kapan saja.</p>
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
