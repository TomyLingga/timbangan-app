import { describe, expect, it } from "vitest";

import { canChangeRegistration } from "@/lib/permissions";
import { changeNotice, changeQuery } from "@/lib/registration-changes";
import type { Permissions, User } from "@/lib/types";
import { emptyTruck, truckPayload } from "@/lib/workflow-forms";

const params = (query: string) => new URLSearchParams(query);

const staff = (permissions: Permissions): User => ({ id: "u-1", kind: "INTERNAL", username: "staf", fullName: "Staf Contoh", permissions, partner: null });
const supplier: User = {
  id: "u-2",
  kind: "PARTNER",
  username: "pks",
  fullName: "PKS Contoh",
  permissions: { registrations: "CREATE" },
  partner: { id: "p-1", name: "PKS Contoh", isSupplier: true, isTransporter: false, isCustomer: false },
};

describe("a registration changed after it was sent", () => {
  it("carries the SPJ changes to the registration page and tells what to print", () => {
    const query = changeQuery([
      { tripId: "t-2", seq: 2, plateNo: "ZZ0002CTH", change: "REISSUED" },
      { tripId: "t-3", seq: 3, plateNo: "ZZ0003CTH", change: "ISSUED" },
      { tripId: "t-4", seq: 4, plateNo: "ZZ0004CTH", change: "CANCELLED" },
    ]);
    expect(query).toBe("baru=ubah&cetak=2%2C3&hapus=4");
    expect(changeNotice(params(query))).toBe(
      "Perubahan disimpan. Truk 2 dan 3 punya SPJ baru. Cetak SPJ-nya untuk supir; SPJ lama tidak berlaku lagi di pos. Truk 4 dihapus dan SPJ-nya tidak berlaku lagi.",
    );
    expect(changeNotice(params(changeQuery([{ tripId: "t-1", seq: 1, plateNo: null, change: "WITHDRAWN" }])))).toBe(
      "Perubahan disimpan. Perubahan ini perlu ditinjau logistik. SPJ truk 1 dicabut sampai disetujui.",
    );
    expect(changeNotice(params(changeQuery([])))).toBe("Perubahan disimpan. SPJ tidak berubah, tidak perlu dicetak ulang.");
    expect(changeNotice(params("baru=ubah&cetak=1,2,4"))).toContain("Truk 1, 2, dan 4 punya SPJ baru.");
    expect(changeNotice(params("baru=kirim"))).toBeNull();
  });

  it("is offered to its sender and to staff with EDIT, while the API says it may change", () => {
    const sent = { status: "APPROVED", direction: "IN" as const, edit: { allowed: true } };
    expect(canChangeRegistration(supplier, sent)).toBe(true);
    expect(canChangeRegistration(staff({ registrations: "EDIT" }), sent)).toBe(true);
    expect(canChangeRegistration(staff({ registrations: "CREATE" }), sent)).toBe(false);
    expect(canChangeRegistration(supplier, { ...sent, edit: { allowed: false } })).toBe(false);
    expect(canChangeRegistration(supplier, { ...sent, status: "CANCELLED" })).toBe(false);
    // a draft as before
    expect(canChangeRegistration(supplier, { status: "DRAFT", direction: "IN" })).toBe(true);
  });

  it("names the truck it changes, and sends none for a new one", () => {
    expect(truckPayload({ ...emptyTruck("a"), tripId: "trip-7" }).id).toBe("trip-7");
    expect("id" in truckPayload(emptyTruck("b"))).toBe(false);
  });
});
