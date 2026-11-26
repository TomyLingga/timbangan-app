"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { AccessDenied, ListError, ListSkeleton, Notice } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { IncomingForm } from "@/features/registrations/incoming-form";
import { OutgoingForm } from "@/features/registrations/outgoing-form";
import { useApiQuery } from "@/hooks/use-api-query";
import { canChangeRegistration, canView } from "@/lib/permissions";
import { api } from "@/lib/session";
import type { Registration, User } from "@/lib/types";

function EditDraft({ user, id }: { user: User; id: string }) {
  const query = useApiQuery(`edit|${id}`, (signal) =>
    api.request<{ registration: Registration }>(`/api/registrations/${encodeURIComponent(id)}`, { signal }),
  );
  if (query.hasError) return <ListError title="Registrasi belum bisa dimuat" error={query.error} onRetry={query.reload} />;
  if (!query.data) return <ListSkeleton label="Memuat registrasi" />;
  const registration = query.data.registration;
  if (!canChangeRegistration(user, registration)) {
    const status = registration.status.toUpperCase();
    return (
      <div className="flex flex-col items-start gap-4">
        <Notice tone="warning">
          {registration.edit && !registration.edit.allowed && registration.edit.reason
            ? `Registrasi ini tidak bisa diubah lagi: ${registration.edit.reason.charAt(0).toLowerCase()}${registration.edit.reason.slice(1)}`
            : status === "DRAFT" || status === "SUBMITTED" || status === "APPROVED"
              ? "Akun Anda tidak bisa mengubah registrasi ini."
              : "Registrasi ini sudah selesai, ditolak, atau dibatalkan, jadi isinya tidak bisa diubah."}
        </Notice>
        <Button asChild variant="secondary">
          <Link href={`/registrasi/${encodeURIComponent(id)}`}>Kembali ke registrasi</Link>
        </Button>
      </div>
    );
  }
  return registration.direction === "IN" ? (
    <IncomingForm draft={registration} />
  ) : (
    <OutgoingForm orderId={null} draft={registration} />
  );
}

/** /registrasi/<id>/ubah: a draft, or a sent registration before its trucks check in, opened in its form and saved with PUT. */
export function EditRegistrationScreen() {
  const params = useParams<{ id: string }>();
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  if (!canView(state.user, "registrations")) return <AccessDenied module="registrations" />;
  return <EditDraft user={state.user} id={params.id} />;
}
