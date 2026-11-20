"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleAlert, Eye, EyeOff, Loader2 } from "lucide-react";
import { motion } from "motion/react";

import { AppMark } from "@/components/app-mark";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/auth-provider";
import { SSO_START_URL } from "@/lib/config";
import { loginErrorMessage } from "@/lib/messages";
import { MOTION_BASE } from "@/lib/motion";

interface FieldErrors {
  username?: string;
  password?: string;
}

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

  const signedIn = state.status === "authenticated" || state.status === "no-role";

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
    <main className="flex min-h-dvh flex-col bg-background">
      <div className="flex items-center justify-between px-4 py-3 sm:px-6">
        <AppMark />
        <ThemeToggle />
      </div>

      <div className="flex flex-1 items-center justify-center px-4 pt-4 pb-12 sm:px-6">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: MOTION_BASE }}
          className="w-full max-w-3xl"
        >
          <h1 className="text-2xl font-semibold tracking-tight">Masuk</h1>
          <p className="mt-1 text-sm text-muted-foreground">Pilih cara masuk sesuai jenis akun Anda.</p>

          {state.status === "anonymous" && state.notice === "expired" ? (
            <p
              role="status"
              className="mt-4 flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2.5 text-sm text-warning"
            >
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Sesi berakhir. Masuk lagi untuk melanjutkan.
            </p>
          ) : null}

          <div className="mt-6 grid overflow-hidden rounded-lg border bg-card md:grid-cols-2">
            <section aria-labelledby={`${ids}-staff`} className="flex flex-col p-5 sm:p-6">
              <h2 id={`${ids}-staff`} className="text-base font-semibold">
                Karyawan INL
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Masuk dengan akun Portal INL. Anda akan dibawa ke portal, lalu kembali ke sini.
              </p>
              <Button asChild size="lg" className="mt-5 w-full md:mt-auto">
                <a href={SSO_START_URL}>
                  Masuk lewat Portal INL
                  <ArrowRight aria-hidden="true" />
                </a>
              </Button>
            </section>

            <section
              aria-labelledby={`${ids}-partner`}
              className="border-t p-5 sm:p-6 md:border-t-0 md:border-l"
            >
              <h2 id={`${ids}-partner`} className="text-base font-semibold">
                Perusahaan partner
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">Untuk akun PKS, transporter, dan customer.</p>

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
            </section>
          </div>
        </motion.div>
      </div>
    </main>
  );
}
