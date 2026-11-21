"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { AccessDenied, PageHeader } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { IncomingForm } from "@/features/registrations/incoming-form";
import { OutgoingForm } from "@/features/registrations/outgoing-form";
import { canCreateIncoming, canCreateOutgoing } from "@/lib/permissions";

/** /registrasi/baru?arah=in, or ?arah=out&do=<id>. */
export function NewRegistrationScreen() {
  const searchParams = useSearchParams();
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  const user = state.user;
  const direction = searchParams.get("arah");

  if (direction === "in") {
    if (!canCreateIncoming(user)) {
      return (
        <AccessDenied
          module="registrations"
          reason="Registrasi incoming dibuat oleh akun pemasok atau karyawan dengan hak akses Registrasi tingkat buat."
        />
      );
    }
    return <IncomingForm />;
  }
  if (direction === "out") {
    if (!canCreateOutgoing(user)) {
      return (
        <AccessDenied
          module="registrations"
          reason="Registrasi outgoing dibuat oleh akun transporter atau karyawan dengan hak akses Registrasi tingkat buat."
        />
      );
    }
    return <OutgoingForm orderId={searchParams.get("do")} />;
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Registrasi baru" description="Pilih arah truk." />
      <div className="flex flex-wrap gap-2">
        {canCreateIncoming(user) ? (
          <Button asChild>
            <Link href="/registrasi/baru?arah=in">Incoming (pembelian)</Link>
          </Button>
        ) : null}
        {canCreateOutgoing(user) ? (
          <Button asChild variant="outline">
            <Link href="/registrasi/baru?arah=out">Outgoing (penjualan)</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
