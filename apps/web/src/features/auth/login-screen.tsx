"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Building2, CircleAlert, Eye, EyeOff, IdCard, Loader2 } from "lucide-react";
import { motion } from "motion/react";

import { AppMark } from "@/components/app-mark";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlantScene } from "@/features/auth/plant-scene";
import { useAuth } from "@/features/auth/auth-provider";
import { SSO_START_URL } from "@/lib/config";
import { loginErrorMessage } from "@/lib/messages";
import { MOTION_EASE, MOTION_SLOW } from "@/lib/motion";

interface FieldErrors {
  username?: string;
  password?: string;
}

/** Entrance of one block of the form column, in reading order. */
const enter = (order: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: MOTION_SLOW, ease: MOTION_EASE, delay: 0.08 + order * 0.06 },
});

export function LoginScreen() {
  const router = useRouter();
  const { state, signIn } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const usernameErrorId = `${ids}-username-error`;
  const passwordErrorId = `${ids}-password-error`;
  const formErrorId = `${ids}-form-error`;

  const signedIn = state.status === "authenticated" || state.status === "no-access";

  // Someone who already has a session has no business on this page.
  useEffect(() => {
    if (signedIn) router.replace("/");
  }, [signedIn, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;

    const errors: FieldErrors = {};
    if (!username.trim()) errors.username = "Isi nama pengguna.";
    if (!password) errors.password = "Isi kata sandi.";
    setFieldErrors(errors);
    setFormError(null);
    if (errors.username) {
      usernameRef.current?.focus();
      return;
    }
    if (errors.password) {
      passwordRef.current?.focus();
      return;
    }

    setSending(true);
    try {
      await signIn(username.trim(), password);
      router.replace("/");
    } catch (error) {
      setFormError(loginErrorMessage(error));
      setSending(false);
    }
  }

  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-[minmax(0,7fr)_minmax(26rem,5fr)]">
      {/* The plant, seen from above. */}
      <section
        aria-label="Alur truk di pabrik"
        className="site-grid relative flex flex-col overflow-hidden border-b bg-surface lg:m-3 lg:rounded-2xl lg:border lg:shadow-panel"
      >
        <div className="relative z-10 flex items-center justify-between px-4 pt-3 sm:px-6 lg:px-8 lg:pt-7">
          <AppMark />
          <div className="lg:hidden">
            <ThemeToggle />
          </div>
        </div>

        <div className="relative z-10 hidden px-8 pt-10 lg:block">
          <motion.p
            {...enter(0)}
            className="max-w-[17ch] font-display text-[clamp(2.25rem,1.2rem+2.2vw,3.5rem)] leading-[1.05] font-semibold tracking-[-0.02em] text-balance"
          >
            Setiap truk lewat jalur yang sama.
          </motion.p>
          <motion.p {...enter(1)} className="mt-4 max-w-[46ch] text-[0.9375rem] leading-relaxed text-muted-foreground">
            Daftar sebelum datang, check-in di pos dengan kartu RFID, lalu timbang, cek mutu, bongkar atau muat, segel,
            dan timbang lagi sebelum keluar.
          </motion.p>
        </div>

        <div className="relative mt-1 h-60 sm:h-72 lg:hidden">
          <PlantScene fit="slice" className="h-full w-full" />
        </div>
        <div className="relative mt-auto hidden px-6 pb-6 lg:block">
          <PlantScene className="h-auto max-h-[58vh] w-full" />
        </div>
      </section>

      {/* The two ways in. */}
      <div className="flex flex-col px-4 pb-12 sm:px-6 lg:px-12">
        <div className="hidden justify-end pt-6 lg:flex">
          <ThemeToggle />
        </div>

        <div className="mx-auto flex w-full max-w-[26rem] flex-1 flex-col justify-center pt-7 lg:pt-0">
          <motion.h1 {...enter(1)} className="text-[2rem] leading-none font-semibold tracking-[-0.03em]">
            Masuk
          </motion.h1>
          <motion.p {...enter(2)} className="mt-2 text-sm text-muted-foreground">
            Pilih cara masuk sesuai jenis akun Anda.
          </motion.p>

          {state.status === "anonymous" && state.notice === "expired" ? (
            <p
              role="status"
              className="mt-5 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2.5 text-sm text-warning"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Sesi berakhir. Masuk lagi untuk melanjutkan.
            </p>
          ) : null}

          <motion.section
            {...enter(3)}
            aria-labelledby={`${ids}-staff`}
            className="mt-7 rounded-2xl border bg-card p-5 shadow-panel"
          >
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary-subtle text-primary-ink">
                <IdCard className="size-[1.125rem]" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 id={`${ids}-staff`} className="text-base font-semibold">
                  Karyawan INL
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Masuk dengan akun Portal INL. Anda akan dibawa ke portal, lalu kembali ke sini.
                </p>
              </div>
            </div>
            <Button asChild size="lg" className="group/sso mt-4 w-full">
              <a href={SSO_START_URL}>
                Masuk lewat Portal INL
                <ArrowRight className="transition-transform duration-200 group-hover/sso:translate-x-1" aria-hidden="true" />
              </a>
            </Button>
          </motion.section>

          <motion.div {...enter(4)} className="my-5 flex items-center gap-3 text-xs text-muted-foreground" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            atau
            <span className="h-px flex-1 bg-border" />
          </motion.div>

          <motion.section {...enter(5)} aria-labelledby={`${ids}-partner`} className="rounded-2xl border bg-card p-5 shadow-panel">
            <div className="flex items-start gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                <Building2 className="size-[1.125rem]" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 id={`${ids}-partner`} className="text-base font-semibold">
                  Perusahaan partner
                </h2>
                <p className="mt-0.5 text-sm text-muted-foreground">Untuk akun PKS, transporter, dan customer.</p>
              </div>
            </div>

            <form
              onSubmit={handleSubmit}
              noValidate
              aria-describedby={formError ? formErrorId : undefined}
              className="mt-5 flex flex-col gap-4"
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${ids}-username`}>Nama pengguna</Label>
                <Input
                  ref={usernameRef}
                  id={`${ids}-username`}
                  name="username"
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  aria-invalid={fieldErrors.username ? true : undefined}
                  aria-describedby={fieldErrors.username ? usernameErrorId : undefined}
                  className="h-11"
                />
                {fieldErrors.username ? (
                  <p id={usernameErrorId} className="text-sm text-destructive">
                    {fieldErrors.username}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor={`${ids}-password`}>Kata sandi</Label>
                <div className="relative">
                  <Input
                    ref={passwordRef}
                    id={`${ids}-password`}
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-invalid={fieldErrors.password ? true : undefined}
                    aria-describedby={fieldErrors.password ? passwordErrorId : undefined}
                    className="h-11 pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((shown) => !shown)}
                    aria-label={showPassword ? "Sembunyikan kata sandi" : "Tampilkan kata sandi"}
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" aria-hidden="true" />
                    ) : (
                      <Eye className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {fieldErrors.password ? (
                  <p id={passwordErrorId} className="text-sm text-destructive">
                    {fieldErrors.password}
                  </p>
                ) : null}
              </div>

              <Button type="submit" variant="secondary" size="lg" disabled={sending} className="w-full">
                {sending ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden="true" />
                    Memeriksa
                  </>
                ) : (
                  "Masuk"
                )}
              </Button>

              <div aria-live="polite">
                {formError ? (
                  <p id={formErrorId} className="flex items-start gap-2 text-sm text-destructive">
                    <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    {formError}
                  </p>
                ) : null}
              </div>
            </form>
          </motion.section>
        </div>
      </div>
    </main>
  );
}
