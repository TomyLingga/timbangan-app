import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api-client";
import {
  cardSaveErrorMessage,
  gateErrorMessage,
  registrationErrorMessage,
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
    expect(deliveryOrderStatusInfo("SENT")).toEqual({ label: "Menunggu transporter", tone: "warning" });
    expect(deliveryOrderStatusInfo("ACCEPTED")).toEqual({ label: "Diterima transporter", tone: "success" });
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
    expect(checkSentence({ code: "OVER_CONTRACT", message: null })).toBe("Netto surat melebihi sisa kontrak.");
    expect(checkSentence({ code: "VEHICLE_UNVERIFIED", message: null })).toBe(
      "Kendaraan baru dan belum diverifikasi admin.",
    );
  });

  it("turns post check codes into plain sentences", () => {
    expect(checkSentence({ code: "ALREADY_CHECKED_IN", message: null })).toBe("Truk ini sudah check-in.");
    expect(checkSentence({ code: "SPJ_EXPIRED", message: null })).toBe("Masa berlaku SPJ sudah lewat.");
  });

  it("shows the server text for a code it does not know, or the code itself", () => {
    expect(checkSentence({ code: "NEW_RULE", message: "Aturan baru" })).toBe("Aturan baru");
    expect(checkSentence({ code: "NEW_RULE", message: null })).toBe("NEW_RULE");
  });
});

describe("findingWhere", () => {
  it("names the truck and the contract a finding is about", () => {
    expect(findingWhere({ code: "X", message: null, tripSeq: 2, allocationSeq: 1 })).toBe("Truk 2, alokasi 1");
    expect(findingWhere({ code: "X", message: null, tripSeq: 3 })).toBe("Truk 3");
    expect(findingWhere({ code: "X", message: null })).toBeNull();
  });
});

describe("isBlocking", () => {
  it("is true only for BLOCK, whatever the letter case", () => {
    expect(isBlocking({ code: "X", level: "BLOCK", message: null })).toBe(true);
    expect(isBlocking({ code: "X", level: "block", message: null })).toBe(true);
    expect(isBlocking({ code: "X", level: "WARN", message: null })).toBe(false);
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
  });

  it("falls back to the general wording", () => {
    expect(gateErrorMessage(error(0, "NETWORK_ERROR"))).toBe("Server tidak bisa dihubungi. Periksa jaringan, lalu coba lagi.");
    expect(gateErrorMessage(error(409, "SOMETHING_ELSE"))).toBe("Permintaan gagal (kode 409).");
  });
});

describe("registrationErrorMessage", () => {
  it("explains the hard refusals of a registration", () => {
    expect(registrationErrorMessage(error(422, "DRIVER_BLACKLISTED"))).toBe(
      "Supir ini masuk daftar hitam VCF, jadi registrasi tidak bisa disimpan. Ganti supirnya.",
    );
    expect(registrationErrorMessage(error(422, "DRIVER_BLOCKED"))).toBe(
      "Supir ini sedang diblokir di pabrik, jadi registrasi tidak bisa disimpan. Ganti supirnya.",
    );
    expect(registrationErrorMessage(error(400, "FLOW_MISMATCH"))).toBe(
      "Kontrak yang dipilih tidak bisa digabung dalam satu registrasi karena alur barangnya berbeda.",
    );
    expect(registrationErrorMessage(error(400, "TOO_MANY_ALLOCATIONS"))).toBe(
      "Terlalu banyak kontrak atau DO untuk satu registrasi.",
    );
    expect(registrationErrorMessage(error(409, "DUPLICATE_IN_REGISTRATION"))).toBe(
      "Kendaraan atau supir yang sama dipakai dua kali dalam registrasi ini.",
    );
  });

  it("asks to check the marked fields on a validation error", () => {
    expect(registrationErrorMessage(error(400, "VALIDATION"))).toBe(
      "Server menolak isian ini. Periksa kolom yang ditandai, lalu kirim lagi.",
    );
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
    expect(cardSaveErrorMessage(error(409, "CARD_IN_USE"))).toBe(
      "Kartu ini sedang terikat ke truk, jadi statusnya belum bisa diubah.",
    );
  });
});
