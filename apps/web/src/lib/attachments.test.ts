import { describe, expect, it } from "vitest";

import { canChangeDoFiles, canChangeSlips, checkAttachment, formatFileSize } from "@/lib/attachments";
import type { Permissions, User } from "@/lib/types";

const MB = 1024 * 1024;

function staff(permissions: Permissions): User {
  return { id: "u-1", kind: "INTERNAL", username: "staf", fullName: "Staf Contoh", permissions, partner: null };
}

function partner(permissions: Permissions, kinds: { supplier?: boolean; transporter?: boolean } = {}): User {
  return {
    id: "u-2",
    kind: "PARTNER",
    username: "mitra",
    fullName: "Mitra Contoh",
    permissions,
    partner: { id: "p-1", name: "PKS Contoh", isSupplier: kinds.supplier ?? false, isTransporter: kinds.transporter ?? false, isCustomer: false },
  };
}

describe("checkAttachment", () => {
  it("takes a PDF up to 10 MB and an image up to 5 MB", () => {
    expect(checkAttachment({ name: "surat.pdf", type: "application/pdf", size: 10 * MB })).toBeNull();
    expect(checkAttachment({ name: "slip.jpg", type: "image/jpeg", size: 5 * MB })).toBeNull();
    expect(checkAttachment({ name: "slip.webp", type: "image/webp", size: 1 })).toBeNull();
    expect(checkAttachment({ name: "surat.pdf", type: "application/pdf", size: 10 * MB + 1 })).toBe("PDF paling besar 10 MB.");
    expect(checkAttachment({ name: "slip.png", type: "image/png", size: 5 * MB + 1 })).toBe("Gambar paling besar 5 MB.");
  });

  it("falls back to the extension when the browser gives no type, and refuses other files", () => {
    expect(checkAttachment({ name: "SLIP.PDF", type: "", size: 100 })).toBeNull();
    expect(checkAttachment({ name: "slip.jpeg", type: "", size: 100 })).toBeNull();
    expect(checkAttachment({ name: "slip.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 100 })).toBe(
      "Pilih berkas PDF atau gambar JPEG, PNG, atau WebP.",
    );
    expect(checkAttachment({ name: "gambar.svg", type: "image/svg+xml", size: 100 })).toBe("Pilih berkas PDF atau gambar JPEG, PNG, atau WebP.");
    expect(checkAttachment({ name: "kosong.pdf", type: "application/pdf", size: 0 })).toBe("Berkas ini kosong.");
  });
});

describe("formatFileSize", () => {
  it("shows bytes, kilobytes and megabytes the Indonesian way", () => {
    expect(formatFileSize(900)).toBe("900 B");
    expect(formatFileSize(820 * 1024)).toBe("820 KB");
    expect(formatFileSize(1.5 * MB)).toBe("1,5 MB");
    expect(formatFileSize(null)).toBe("-");
  });
});

describe("canChangeDoFiles", () => {
  it("is for staff with delivery_orders CREATE while the DO is a draft or sent", () => {
    const office = staff({ delivery_orders: "CREATE" });
    expect(canChangeDoFiles(office, { status: "DRAFT" })).toBe(true);
    expect(canChangeDoFiles(office, { status: "SENT" })).toBe(true);
    expect(canChangeDoFiles(office, { status: "ACCEPTED" })).toBe(false);
    expect(canChangeDoFiles(staff({ delivery_orders: "VIEW" }), { status: "DRAFT" })).toBe(false);
    expect(canChangeDoFiles(partner({ delivery_orders: "EDIT" }, { transporter: true }), { status: "SENT" })).toBe(false);
  });
});

describe("canChangeSlips", () => {
  it("lets the supplier change its own incoming draft and staff with EDIT an open registration", () => {
    const supplier = partner({ registrations: "CREATE" }, { supplier: true });
    expect(canChangeSlips(supplier, { status: "DRAFT", direction: "IN" })).toBe(true);
    expect(canChangeSlips(supplier, { status: "APPROVED", direction: "IN" })).toBe(false);
    expect(canChangeSlips(partner({ registrations: "CREATE" }, { transporter: true }), { status: "DRAFT", direction: "IN" })).toBe(false);
    const desk = staff({ registrations: "EDIT" });
    expect(canChangeSlips(desk, { status: "APPROVED", direction: "IN" })).toBe(true);
    expect(canChangeSlips(desk, { status: "CANCELLED", direction: "IN" })).toBe(false);
    expect(canChangeSlips(desk, { status: "DRAFT", direction: "OUT" })).toBe(false);
    expect(canChangeSlips(staff({ registrations: "CREATE" }), { status: "DRAFT", direction: "IN" })).toBe(false);
  });
});
