// A registration changed after it was sent (owner, 26 November 2026: "data yg dikirim transporter atau supplier, jika
// belum di scan barcode / di proses di INL, masih bisa di edit"). PUT /api/registrations/:id answers `spjChanges`: the
// trucks that got a new SPJ (the printed barcode shows the old plate), lost theirs until logistics review, or were
// removed. The form carries them to the registration page in the address, and the page tells the sender what to print.

import type { SpjChange } from "@/lib/types";

/** The address query of the registration page after a change: `?baru=ubah&cetak=2,3&tarik=1&hapus=4`. */
export function changeQuery(changes: readonly SpjChange[]): string {
  const seqs = (...kinds: SpjChange["change"][]) =>
    changes
      .filter((change) => kinds.includes(change.change))
      .map((change) => change.seq)
      .join(",");
  const query = new URLSearchParams({ baru: "ubah" });
  const print = seqs("REISSUED", "ISSUED");
  const withdrawn = seqs("WITHDRAWN");
  const removed = seqs("CANCELLED");
  if (print) query.set("cetak", print);
  if (withdrawn) query.set("tarik", withdrawn);
  if (removed) query.set("hapus", removed);
  return query.toString();
}

/** "truk 2", "truk 2 dan 3", "truk 1, 2, dan 4". */
function trucks(list: string | null): string | null {
  const seqs = (list ?? "").split(",").filter((item) => /^\d+$/.test(item));
  if (seqs.length === 0) return null;
  if (seqs.length === 1) return `truk ${seqs[0]}`;
  return `truk ${seqs.slice(0, -1).join(", ")}${seqs.length > 2 ? "," : ""} dan ${seqs.at(-1)}`;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The notice after a change, from the address query; null when the address is not one of a change. */
export function changeNotice(params: { get: (name: string) => string | null }): string | null {
  if (params.get("baru") !== "ubah") return null;
  const parts = ["Perubahan disimpan."];
  const withdrawn = trucks(params.get("tarik"));
  const print = trucks(params.get("cetak"));
  const removed = trucks(params.get("hapus"));
  if (withdrawn) parts.push(`Perubahan ini perlu ditinjau logistik. SPJ ${withdrawn} dicabut sampai disetujui.`);
  if (print) parts.push(`${capital(print)} punya SPJ baru. Cetak SPJ-nya untuk supir; SPJ lama tidak berlaku lagi di pos.`);
  if (removed) parts.push(`${capital(removed)} dihapus dan SPJ-nya tidak berlaku lagi.`);
  if (!withdrawn && !print && !removed) parts.push("SPJ tidak berubah, tidak perlu dicetak ulang.");
  return parts.join(" ");
}
