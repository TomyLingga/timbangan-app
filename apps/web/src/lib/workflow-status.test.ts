import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-client";
import {
  cardSaveErrorMessage,
  gateErrorMessage,
  registrationErrorMessage,
  SHIPMENT_REQUEST_REQUIRED_TEXT,
  shipmentRequestErrorMessage,
  transitionErrorMessage,
} from "@/lib/messages";
import {
  cardStatusInfo,
  checkSentence,
  deliveryOrderStatusInfo,
  findingWhere,
  isBlocking,
  registrationStatusInfo,
  tripStatusInfo,
} from "@/lib/status";

const error = (status: number, code: string) => new ApiError(status, code, "english text from the api");

describe("status labels", () => {
  it("labels every delivery order status", () => {
    expect(deliveryOrderStatusInfo("DRAFT")).toEqual({ label: "Draf", tone: "neutral" });
    expect(deliveryOrderStatusInfo("SENT")).toEqual({ label: "Menunggu diterima", tone: "warning" });
    expect(deliveryOrderStatusInfo("ACCEPTED")).toEqual({ label: "Diterima", tone: "success" });
    expect(deliveryOrderStatusInfo("CLOSED")).toEqual({ label: "Tutup", tone: "neutral" });
    expect(deliveryOrderStatusInfo("CANCELLED")).toEqual({ label: "Batal", tone: "destructive" });
  });

  it("labels every registration status", () => {
    expect(registrationStatusInfo("DRAFT").label).toBe("Draf");
    expect(registrationStatusInfo("SUBMITTED")).toEqual({ label: "Menunggu tinjauan", tone: "warning" });
    expect(registrationStatusInfo("APPROVED")).toEqual({ label: "Disetujui", tone: "success" });
    expect(registrationStatusInfo("REJECTED")).toEqual({ label: "Ditolak", tone: "destructive" });
    expect(registrationStatusInfo("CANCELLED").label).toBe("Batal");
  });

  it("labels trip statuses, and shows a later phase's status as received", () => {
    expect(tripStatusInfo("READY").label).toBe("Menunggu tinjauan");
    expect(tripStatusInfo("ISSUED")).toEqual({ label: "SPJ terbit", tone: "success" });
    expect(tripStatusInfo("CHECKED_IN")).toEqual({ label: "Sudah check-in", tone: "success" });
    expect(tripStatusInfo("EXPIRED")).toEqual({ label: "SPJ kedaluwarsa", tone: "destructive" });
    expect(tripStatusInfo("IN_PROCESS")).toEqual({ label: "Dalam proses", tone: "success" });
    expect(tripStatusInfo("COMPLETED")).toEqual({ label: "Selesai", tone: "neutral" });
    expect(tripStatusInfo("REJECTED")).toEqual({ label: "Ditolak", tone: "destructive" });
    expect(tripStatusInfo("WEIGHING_1")).toEqual({ label: "WEIGHING_1", tone: "neutral" });
  });

  it("labels card statuses", () => {
    expect(cardStatusInfo("AVAILABLE")).toEqual({ label: "Tersedia", tone: "success" });
    expect(cardStatusInfo("IN_USE")).toEqual({ label: "Dipakai truk", tone: "warning" });
    expect(cardStatusInfo("LOST")).toEqual({ label: "Hilang", tone: "destructive" });
    expect(cardStatusInfo("RETIRED")).toEqual({ label: "Tidak dipakai lagi", tone: "neutral" });
  });
});

describe("checkSentence", () => {
  it("turns finding codes into plain sentences", () => {
    expect(checkSentence({ code: "DRIVER_WARNING", message: "x" })).toBe("Supir berstatus Warning di VCF.");
    expect(checkSentence({ code: "OVER_CONTRACT", message: "x" })).toBe("Netto surat melebihi sisa kontrak.");
    expect(checkSentence({ code: "VEHICLE_UNVERIFIED", message: "x" })).toBe(
      "Kendaraan baru dan belum diverifikasi admin.",
    );
  });

  it("turns post check codes into plain sentences", () => {
    expect(checkSentence({ code: "ALREADY_CHECKED_IN", message: "x" })).toBe("Truk ini sudah check-in.");
    expect(checkSentence({ code: "SPJ_EXPIRED", message: "x" })).toBe("Masa berlaku SPJ sudah lewat.");
    expect(checkSentence({ code: "DRIVER_BLOCKED", message: "x" })).toBe("Supir sedang diblokir di pabrik ini.");
  });

  it("has no sentence for codes the API does not send", () => {
    // the scan answers SPJ_REVOKED for a cancelled trip; an SPJ that is not issued has no token
    expect(checkSentence({ code: "TRIP_CANCELLED", message: "Teks server" })).toBe("Teks server");
    expect(checkSentence({ code: "TRIP_NOT_ISSUED", message: "Teks server" })).toBe("Teks server");
  });

  it("shows the server text for a code it does not know, or the code itself", () => {
    expect(checkSentence({ code: "NEW_RULE", message: "Aturan baru" })).toBe("Aturan baru");
    expect(checkSentence({ code: "NEW_RULE", message: " " })).toBe("NEW_RULE");
  });
});

describe("findingWhere", () => {
  it("names the truck and the contract a finding is about", () => {
    expect(findingWhere({ code: "X", message: "x", tripSeq: 2, allocationSeq: 1 })).toBe("Truk 2, alokasi 1");
    expect(findingWhere({ code: "X", message: "x", tripSeq: 3 })).toBe("Truk 3");
    expect(findingWhere({ code: "X", message: "x" })).toBeNull();
  });
});

describe("isBlocking", () => {
  it("is true only for BLOCK", () => {
    expect(isBlocking({ code: "X", level: "BLOCK", message: "x" })).toBe(true);
    expect(isBlocking({ code: "X", level: "WARN", message: "x" })).toBe(false);
  });
});

describe("gateErrorMessage", () => {
  it("explains every refusal code of the post", () => {
    expect(gateErrorMessage(error(404, "SPJ_NOT_FOUND"))).toBe(
      "Kode SPJ ini tidak dikenal. Periksa lagi kodenya, atau minta SPJ dicetak ulang.",
    );
    expect(gateErrorMessage(error(409, "SPJ_EXPIRED"))).toBe("Masa berlaku SPJ sudah lewat. Truk tidak bisa check-in dengan SPJ ini.");
    expect(gateErrorMessage(error(409, "SPJ_REVOKED"))).toBe("SPJ ini sudah dicabut. Truk perlu SPJ yang baru.");
    expect(gateErrorMessage(error(409, "ALREADY_CHECKED_IN"))).toBe(
      "Truk ini sudah check-in. SPJ yang sama tidak bisa dipakai dua kali.",
    );
    expect(gateErrorMessage(error(409, "CARD_UNKNOWN"))).toBe(
      "Kartu ini belum terdaftar. Pakai kartu lain, atau minta admin logistik mendaftarkannya.",
    );
    expect(gateErrorMessage(error(409, "CARD_IN_USE"))).toBe("Kartu ini sedang dipakai truk lain. Pakai kartu lain.");
    expect(gateErrorMessage(error(409, "CARD_NOT_AVAILABLE"))).toBe(
      "Kartu ini tercatat hilang atau tidak dipakai lagi. Pakai kartu lain.",
    );
    expect(gateErrorMessage(error(409, "VEHICLE_INSIDE"))).toBe(
      "Kendaraan ini masih tercatat di dalam pabrik. Selesaikan perjalanan sebelumnya dulu.",
    );
    expect(gateErrorMessage(error(409, "DRIVER_INSIDE"))).toBe(
      "Supir ini masih tercatat di dalam pabrik. Selesaikan perjalanan sebelumnya dulu.",
    );
    expect(gateErrorMessage(error(409, "DRIVER_BLACKLISTED"))).toBe("Supir masuk daftar hitam VCF. Truk tidak boleh check-in.");
    expect(gateErrorMessage(error(409, "DRIVER_BLOCKED"))).toBe("Supir sedang diblokir di pabrik ini. Truk tidak boleh check-in.");
    expect(gateErrorMessage(error(409, "INVALID_STATE"))).toBe("Status truk ini tidak memungkinkan tindakan itu. Scan ulang SPJ-nya.");
  });

  it("shows the server sentence for a refusal code it does not know", () => {
    const refused = new ApiError(409, "DRIVER_WARNING", "Supir Contoh berstatus peringatan di VCF.");
    expect(gateErrorMessage(refused)).toBe("Supir Contoh berstatus peringatan di VCF.");
  });

  it("falls back to the general wording", () => {
    expect(gateErrorMessage(error(0, "NETWORK_ERROR"))).toBe("Server tidak bisa dihubungi. Periksa jaringan, lalu coba lagi.");
    expect(gateErrorMessage(error(403, "FORBIDDEN"))).toBe("Akun ini tidak punya izin untuk data ini.");
  });
});

describe("registrationErrorMessage", () => {
  it("explains the refusals of a registration with the codes the API uses", () => {
    expect(registrationErrorMessage(error(409, "DRIVER_BLACKLISTED"))).toBe(
      "Supir ini masuk daftar hitam VCF, jadi registrasi tidak bisa disimpan. Ganti supirnya.",
    );
    expect(registrationErrorMessage(error(409, "DRIVER_BLOCKED"))).toBe(
      "Supir ini sedang diblokir di pabrik, jadi registrasi tidak bisa disimpan. Ganti supirnya.",
    );
    expect(registrationErrorMessage(error(409, "CONTRACT_NOT_AVAILABLE"))).toBe(
      "Ada kontrak yang tidak terbuka lagi atau bukan milik perusahaan Anda. Hapus kontrak itu dari registrasi.",
    );
    expect(registrationErrorMessage(error(409, "DO_NOT_AVAILABLE"))).toBe(
      "Ada DO yang belum diterima, sudah ditutup, atau bukan untuk perusahaan Anda. Hapus DO itu dari registrasi.",
    );
    expect(registrationErrorMessage(error(409, "DUPLICATE_VEHICLE"))).toBe("Satu kendaraan dipakai dua kali dalam registrasi ini.");
    expect(registrationErrorMessage(error(409, "DUPLICATE_DRIVER"))).toBe("Satu supir dipakai dua kali dalam registrasi ini.");
    expect(registrationErrorMessage(error(409, "INVALID_STATE"))).toBe(
      "Registrasi ini sudah berubah status. Muat ulang halaman, lalu coba lagi.",
    );
  });

  it("says plainly that a contract was not sent by INL, with the contract the API names", () => {
    const named = "Kontrak PC-CONTOH-01 belum dikirim INL ke perusahaan Anda. Truk hanya bisa didaftarkan untuk kontrak yang sudah dikirim.";
    expect(registrationErrorMessage(new ApiError(409, "SHIPMENT_REQUEST_REQUIRED", named))).toBe(named);
    expect(registrationErrorMessage(new ApiError(409, "SHIPMENT_REQUEST_REQUIRED", " "))).toBe(SHIPMENT_REQUEST_REQUIRED_TEXT);
  });

  it("no longer knows the codes only the mock had", () => {
    for (const code of ["FLOW_MISMATCH", "TOO_MANY_ALLOCATIONS", "CONTRACT_NOT_OPEN", "DELIVERY_ORDER_NOT_OPEN", "DUPLICATE_IN_REGISTRATION"]) {
      expect(registrationErrorMessage(new ApiError(409, code, "Teks server."))).toBe("Teks server.");
    }
  });

  it("gives the reasons of a validation error that have no field on the form", () => {
    expect(registrationErrorMessage(error(400, "VALIDATION"))).toBe(
      "Server menolak isian ini. Periksa kolom yang ditandai, lalu kirim lagi.",
    );
    expect(
      registrationErrorMessage(error(400, "VALIDATION"), ["Satu truk paling banyak membawa 2 kontrak atau DO pada jalur ini."]),
    ).toBe("Server menolak isian ini: Satu truk paling banyak membawa 2 kontrak atau DO pada jalur ini.");
  });
});

describe("transitionErrorMessage", () => {
  it("explains a status that changed meanwhile", () => {
    expect(transitionErrorMessage(error(409, "INVALID_STATE"))).toBe(
      "Statusnya sudah berubah sejak halaman ini dibuka. Muat ulang halaman, lalu coba lagi.",
    );
    expect(transitionErrorMessage(error(403, "FORBIDDEN"))).toBe("Akun ini tidak punya izin untuk tindakan ini.");
  });
});

describe("cardSaveErrorMessage", () => {
  it("explains a UID that is already registered and a card that is in use", () => {
    expect(cardSaveErrorMessage(error(409, "DUPLICATE"))).toBe("UID kartu ini sudah terdaftar.");
    expect(cardSaveErrorMessage(error(409, "INVALID_STATE"))).toBe(
      "Kartu ini sedang terikat ke truk, jadi statusnya belum bisa diubah.",
    );
  });
});

describe("shipmentRequestErrorMessage", () => {
  it("explains the refusals of a shipment request", () => {
    expect(shipmentRequestErrorMessage(error(409, "SHIPMENT_REQUEST_EXISTS"))).toBe(
      "Kontrak ini sudah punya permintaan pengiriman yang masih terbuka. Buka permintaan itu, atau pilih kontrak lain.",
    );
    expect(shipmentRequestErrorMessage(error(409, "FILE_REQUIRED"))).toBe("Lampirkan dokumen kontrak sebelum permintaan dikirim.");
    expect(shipmentRequestErrorMessage(error(409, "INVALID_STATE"))).toBe("Status permintaan ini sudah berubah. Muat ulang halaman, lalu coba lagi.");
    expect(shipmentRequestErrorMessage(new ApiError(400, "VALIDATION", "x", ["contractId"], { contractId: "Kontrak beli tidak ditemukan atau tidak terbuka." }))).toBe(
      "Server menolak isian ini: Kontrak beli tidak ditemukan atau tidak terbuka.",
    );
    expect(shipmentRequestErrorMessage(error(403, "FORBIDDEN"))).toBe("Akun ini tidak punya izin untuk tindakan ini.");
  });
});
