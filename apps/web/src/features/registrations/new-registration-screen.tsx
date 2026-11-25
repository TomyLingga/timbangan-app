"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { AccessDenied, PageHeader } from "@/components/page-parts";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { IncomingForm } from "@/features/registrations/incoming-form";
import { OutgoingForm } from "@/features/registrations/outgoing-form";
import { canTypeIncoming, canTypeOutgoing, isStaff } from "@/lib/permissions";
import { CONTRACT_PARAM } from "@/lib/shipment-requests";

/** /registrasi/baru?arah=in (&kontrak=<id> from a shipment request), or ?arah=out&do=<id>. */
export function NewRegistrationScreen() {
  const searchParams = useSearchParams();
  const { state } = useAuth();
  if (state.status !== "authenticated") return null;
  const user = state.user;
  const direction = searchParams.get("arah");

  // Staff do not type registrations: a truck comes with the barcode of its partner's registration, or its paper is
  // scanned at the post. The form stays for partner accounts.
  if (isStaff(user)) {
    return (
      <AccessDenied
        module="registrations"
        reason="Registrasi diketik oleh pemasok atau transporter. Truk yang datang tanpa barcode didaftarkan di Pos registrasi lewat scan dokumen."
      />
    );
  }
  if (direction === "in") {
    if (!canTypeIncoming(user)) {
      return <AccessDenied module="registrations" reason="Registrasi incoming dibuat oleh akun pemasok dengan hak akses Registrasi tingkat buat." />;
    }
    // ?kontrak=<id>: opened from a shipment request, with its contract chosen
    return <IncomingForm contractId={searchParams.get(CONTRACT_PARAM)} />;
  }
  if (direction === "out") {
    if (!canTypeOutgoing(user)) {
      return (
        <AccessDenied module="registrations" reason="Registrasi outgoing dibuat oleh akun transporter atau customer dengan hak akses Registrasi tingkat buat." />
      );;
    }
    return <OutgoingForm orderId={searchParams.get("do")} />;
  }
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="Registrasi baru" description="Pilih arah truk." />
      <div className="flex flex-wrap gap-2">
        {canTypeIncoming(user) ? (
          <Button asChild>
            <Link href="/registrasi/baru?arah=in">Incoming (pembelian)</Link>
          </Button>
        ) : null}
        {canTypeOutgoing(user) ? (
          <Button asChild variant="outline">
            <Link href="/registrasi/baru?arah=out">Outgoing (penjualan)</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
